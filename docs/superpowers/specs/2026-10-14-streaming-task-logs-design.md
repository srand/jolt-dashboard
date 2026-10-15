# Streaming task logs in the dashboard log view

Date: 2026-10-14
Status: approved, not yet implemented
Repositories: `jolt` (logstash, scheduler protocol), `jolt-dashboard` (proxy, frontend)

## Goal

When a user opens the log of a running task, the dialog should show the lines
written so far and then keep appending new lines as the task produces them,
ending cleanly when the task finishes. Today the dialog shows a snapshot and
the user has to press reload.

This spec lives in `jolt-dashboard` because the feature is driven from here,
but most of the work lands in `jolt`.

### Success criteria

- Opening the log of a running task shows existing lines, then new lines
  within roughly a second of being written.
- The stream ends by itself when the task completes: no spinner left running,
  no hang, no truncated tail.
- Opening the log of a finished task behaves exactly as it does today.
- The popout tab (`PopoutButton`, a plain browser navigation to the log URL)
  streams on the same terms as the dialog.
- Existing log consumers keep their current behaviour, unchanged and unslowed.

## Background: there is no live log source today

The dashboard does not store logs. The scheduler puts a logstash URL in
`TaskInfo.log` (`services/pkg/scheduler/event_hub.go:294`), the dashboard
persists it as `Task.Log`, and `TaskApi.GetTaskLog` proxies a GET to it
(`backend/api/task.go:108-135`).

Both logstash read paths stop at the end of what has been written:

- `GET /logs/:id` loops until `reader.ReadLine()` returns `io.EOF`
  (`services/pkg/logstash/http.go:25-29`).
- `LogStash.ReadLog` does the same (`services/pkg/logstash/grpc_service.go:44-47`).

Neither supports HTTP range requests. So the only way to build "real time" on
top of today's APIs is repeated polling. Instead, this design gives logstash a
follow mode, which makes every layer above it a straight pipe.

Two facts make follow mode tractable:

- logstash already learns when a writer closes: `fileLogWriter.Close()` calls
  `stash.logClosed(r)` (`services/pkg/logstash/log_writer.go:32`).
- a writer's lifetime already matches a task's. The worker service closes the
  writer when the task reaches a completed status
  (`services/pkg/scheduler/grpc_service_worker.go:356-358`), with a deferred
  close on executor teardown (`:296-300`) covering disconnects and crashes.

So "the last writer for this id has closed" is a sound end-of-stream signal
rather than a heuristic, and it already fires on the failure paths.

## Design overview

Four changes, in dependency order:

1. logstash tracks, per log id, how many writers are open, and notifies
   waiting readers when a line is written or the last writer closes. (`jolt`)
2. A follow-mode reader that blocks rather than returning EOF while a writer
   is still open. (`jolt`)
3. Follow exposed on both logstash APIs, opt-in. (`jolt`)
4. The dashboard proxies the streaming response to the browser, and the dialog
   consumes it incrementally. (`jolt-dashboard`)

The dashboard needs no new protocol stubs and no new configuration: it already
holds the log URL and already proxies it.

## 1. Writer tracking in logstash

`logStash` gains a registry keyed by canonical log path:

```go
type logStream struct {
    writers   int
    followers int
    notify    chan struct{} // closed to wake waiters, then replaced
}
```

Guarded by the existing `logStash.mu`. Lifecycle:

- `Append` creates the entry if absent and increments `writers`.
- `fileLogWriter.WriteLine` calls `stash.logWritten(id)` after a successful
  `Encode`, which wakes waiters.
- `logClosed` decrements `writers`; on reaching zero it wakes waiters so
  followers can observe end-of-stream. It keeps its current LRU behaviour.
- `Follow` increments `followers`; closing a follow reader decrements it.
- `watch(id)` returns the entry's current `notify` channel together with
  whether the log is drained (`writers == 0`), which is what a follow reader
  calls before each read attempt.
- The entry is deleted when `writers` and `followers` are both zero.

Waiters are woken with the close-and-replace broadcast pattern: hold the lock,
`close(notify)`, assign a fresh channel. A waiter must therefore capture the
current channel *before* the read that returns EOF, or it can miss a write
that lands in between and park until the next one. Waiting always happens
outside the lock.

`WriteLine` is on the hot path for every log line, so notification must not
allocate per line when nobody is following: if `followers == 0`, return
without touching the channel.

## 2. The follow reader

Follow mode must not be implemented as "retry `Decode` on EOF". The reader is
a `gob.Decoder` over the file (`services/pkg/logstash/log_reader.go:23`), and a
partially written record yields `io.ErrUnexpectedEOF` with the decoder left
desynced; it cannot be resumed. The fix is to make sure the decoder never sees
a short read, by blocking underneath it:

```go
func (r *tailReader) Read(p []byte) (int, error) {
    for {
        notify, drained := r.stash.watch(r.id) // capture before reading
        n, err := r.file.Read(p)
        if n > 0 {
            return n, nil // even if err == io.EOF
        }
        if err != nil && err != io.EOF {
            return 0, err
        }
        if drained {
            return 0, io.EOF // no writers left: genuine end of log
        }
        select {
        case <-notify:
        case <-r.ctx.Done():
            return 0, r.ctx.Err()
        }
    }
}
```

Three requirements this encodes:

- Return `n, nil` whenever `n > 0`, so a read that reaches the current end of
  file still delivers its bytes.
- Never return `(0, nil)`. `gob` reads through `io.ReadFull`, which treats that
  as "try again" and would spin.
- Wake on context cancellation, so a vanished client does not leak a blocked
  goroutine and an open file handle.

EOF is not sticky for a growing regular file, so the same handle sees appended
bytes on a later read. This holds for `afero.MemMapFs` as well, which the tests
use, but it is load-bearing enough to prove with a test rather than assume.

## 3. Follow on the logstash APIs, opt-in

Follow must be opt-in, because blocking by default would break two existing
callers:

- `download_log` in `jolt/plugins/scheduler.py:209-221` reads a task's log at
  completion. If any writer were still open at that moment, the build client
  would hang.
- `schedulerctl log` (`services/cmd/schedulerctl/cmd_log.go:54-60`) would stall
  on a running task where it returns immediately today. It carries a deadline,
  so it would fail rather than hang — not an improvement.

### Interface

Keep `Read(id string) (LogReader, error)` as it is and add a sibling:

```go
Follow(ctx context.Context, id string) (LogReader, error)
```

This leaves the five existing `Read` call sites in `logstash_test.go` and both
production callers untouched, and makes the two modes legible at the interface.
Both construct a `fileLogReader`; `Follow` wraps the file in `tailReader`
first.

`Follow` on an id with no file returns the same error `Read` does today. It does
not wait for the file to appear: that would need a timeout policy and would
park requests for ids that never exist. The browser retries instead (see
"Edge cases").

### gRPC

Add to `ReadLogRequest` in `services/pkg/logstash/log.proto`:

```proto
    // Do not end the stream while the log is still being written.
    bool follow = 4;
```

`jolt/plugins/remote_execution/log.proto` is a symlink to this file, so there
is one definition to edit. Regenerate the Go stubs with
`services/pkg/protocol/generate.sh`; regenerate the checked-in Python stubs via
the `jolt/protobufs` task in `build.jolt` for consistency, though no Python
caller sets the field.

`LogStashService.ReadLog` picks `Follow(stream.Context(), req.Id)` when
`req.Follow` is set, and is otherwise unchanged. The existing `After`/`Before`
filters compose with follow as they are.

### HTTP

`GET /logs/:id?follow=1` selects `Follow(c.Request().Context(), id)`.

The handler also needs a flushing fix. It currently flushes a `bufio.Writer`
wrapping `c.Response()` (`services/pkg/logstash/http.go:57`), which only moves
bytes into net/http's own buffer; lines then sit there until about 4KB
accumulates. Replace the `bufio.Writer` with a direct write plus
`c.Response().Flush()` per line. Without this, a correct follow reader still
looks broken: output arrives in chunks instead of lines.

Response headers stay as they are — `text/plain`, no content length, so Go
uses chunked transfer encoding.

## 4. Dashboard proxy

`TaskApi.GetTaskLog` (`backend/api/task.go:108-135`) changes in three ways:

- Build the upstream request with `http.NewRequestWithContext` using
  `c.Request().Context()`. Today the context is ignored, which is harmless for
  a short GET but would pin an upstream connection for the rest of a task
  every time a user closes the dialog.
- Accept `?follow=1` on `/api/v1/tasks/:id/log` and pass it through to the
  upstream URL. Any other value, or its absence, proxies a plain read as
  today, so the popout tab follows only when the dialog links it with the
  parameter set.
- Replace `c.Stream(...)` with a read/write/flush loop. `c.Stream` is an
  `io.Copy`, which has the same buffering problem as the logstash handler.

```go
c.Response().Header().Set(echo.HeaderContentType, contentType)
c.Response().Header().Set("X-Accel-Buffering", "no")
// Forward the upstream status rather than assuming 200. The "log not yet
// created" case below depends on logstash's 404 reaching the browser, and
// masking it would also render an upstream error body as log content.
c.Response().WriteHeader(response.StatusCode)

buf := make([]byte, 4096)
for {
    n, err := reader.Read(buf)
    if n > 0 {
        if _, werr := c.Response().Write(buf[:n]); werr != nil {
            return nil
        }
        c.Response().Flush()
    }
    if err != nil {
        return nil
    }
}
```

`X-Accel-Buffering: no` is a precaution: a buffering reverse proxy is the one
deployment where chunked streaming stalls. `docker/Dockerfile` serves the Go
binary directly with nothing in front of it, so this is not a live problem.

The existing `task.Log == ""` check keeps returning 404, and the
`InsecureSkipVerify` transport is unchanged.

### Why HTTP and not a websocket

The dashboard already has websockets (`/api/v1/tasks/events`,
`/api/v1/workers/events`), but they do not fit this:

- `PopoutButton` navigates a browser tab at `/api/v1/tasks/:id/log`
  (`frontend/src/PopoutButton.js:7`, wired at `frontend/src/TaskLog.js:132`). A
  tab cannot open a websocket, so this route has to stream regardless. A
  websocket would be a second path for the same bytes, not a replacement.
- Those websockets are fan-out: one shared stream of global state to every
  client, which is what `model.Broadcast` is for. A log tail is per-viewer and
  per-task, so it would need fresh per-connection plumbing, not reuse.
- Nothing needs to travel client to server. The level filters are client-side
  matching over text the browser already holds
  (`frontend/src/TaskLog.js:36-39`).
- Upstream is already chunked `text/plain`. Proxying bytes avoids inventing a
  message framing that the dialog, the popout tab and `curl` would then have to
  agree on.

If filtering ever moves server-side — logstash's `ReadLogRequest` already has
the fields for it — this decision is worth revisiting.

## 5. Frontend

`TaskLog` currently calls `response.text()` (`frontend/src/TaskLog.js:83`),
which waits for the whole body. It becomes an incremental consumer:

- Read from `response.body.getReader()` and decode with
  `new TextDecoder()` using `{ stream: true }`, appending to `state.log`.
- Hold back a trailing partial line until its newline arrives. The level
  filters index fixed columns (`line[27]`, `line.slice(28, 35)`), so a
  half-delivered line must not reach `Log`.
- Follow only when the task's status is one of `Queued`, `Assigned` or
  `Running`; treat `Passed`, `Failed`, `Cancelled` and `Deleted` as terminal
  and fetch without `follow`. `TaskLog` is handed a task snapshot today, so
  `Tasks.js` passes the live row instead — the tasks websocket already streams
  status changes — which is what the retry and the popout link read.
  A status that turns terminal mid-stream must **not** abort the stream: the
  scheduler writes a task's error details through a second, short-lived writer
  *after* it reports completion, so cutting the stream on the status change
  would truncate exactly those lines and violate the "no truncated tail"
  criterion above. Let the stream end on its own when the last writer closes.
- Abort on close via `AbortController`, and on reload, and on the task
  changing. Reload re-opens the stream from the start.
- Scroll to the bottom when the dialog opens, and keep the view pinned there
  as new lines arrive. If the user scrolls up, leave their position alone
  until they scroll back to the bottom, then resume following.

The initial spinner condition is `log === ""` (`frontend/src/TaskLog.js:22`),
which still holds: it clears on the first batched flush after a chunk
arrives. Chunks are coalesced on a short timer rather than rendered one
by one — logstash flushes per line, and a render per line does quadratic
work on a long log — so "as soon as" means within that interval, well
inside the latency budget above.

## Edge cases

- **Log not yet created.** A task can be Running before its first line is
  written, and the log URL exists from task creation. `Follow` returns the
  current not-found error and the dashboard returns 404. Rather than parking the
  request server-side, the dialog retries every 2 seconds while the task is in a
  non-terminal status, and gives up when it reaches a terminal one. This is the
  only polling left in the design, and it stops as soon as the first line
  exists.
- **A second writer after the first closed.** The error-details path opens a
  short-lived second writer for the same id
  (`services/pkg/scheduler/grpc_service_worker.go:191-231`). If it runs after
  the executor's writer closed, a follower will already have ended and will
  miss those lines. Accepted: re-opening the dialog shows them, and the task's
  status change is what prompts that. Designing around it would mean keeping
  streams open past end-of-log on a timer.
- **Task retried.** A retry calls `Append` again for the same id and seeks to
  the end. A follower that ended in the gap between the two writers stays
  ended; one that was still waiting continues into the new output.
- **LRU eviction mid-follow.** `Append` removes the id from the LRU and
  `logClosed` adds it back, so a log is not evicted while being written. If an
  idle log is evicted while someone follows it, the unlinked file stays
  readable through the open handle on POSIX, and the follower ends at EOF.
- **Client disappears.** Request-context cancellation unwinds the whole chain:
  browser, dashboard proxy, logstash handler, blocked `tailReader`.

## Testing

`jolt`, in `pkg/logstash`:

- A follow read blocks at end of log, returns a line written afterwards, and
  returns `io.EOF` once the last writer closes.
- A follow read returns `io.EOF` immediately when no writer is open.
- A follow read with two writers open ends only after both close.
- A line written with no follower registered does not block the writer.
- Context cancellation unblocks a parked follow read.
- A gob record written in two parts across a wait boundary decodes as one line
  — the regression test for the desync this design exists to avoid.
- `MemMapFs` serves appended bytes on a handle that already hit EOF.
- Existing `Read` tests stay untouched, which is the evidence that the default
  path did not change.

`jolt`, HTTP and gRPC: `?follow=1` and `Follow: true` select follow mode; a
request without them ends at EOF as before; lines reach the client as they are
written rather than in blocks.

`jolt-dashboard`: the proxy cancels its upstream request when the client's
context is cancelled, and forwards `follow`.

Frontend: a chunked response spanning a line boundary renders whole lines only;
closing the dialog aborts the request.

Manual: run a scheduler locally and drive it with
`schedulerctl -s tcp://localhost:9090 mock build -t task1`, then watch the
dialog during execution and confirm it ends by itself at completion.
`curl -N '.../logs/<instance>?follow=1'` is the quickest check of the logstash
layer alone.

## Out of scope

- Server-side level filtering, and any protocol change to carry filters.
- A websocket log transport.
- Range or offset reads on logstash.
- Any change to how the dashboard stores logs; it still stores only a URL.
