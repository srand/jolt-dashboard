# jolt-dashboard

A real-time dashboard for [Jolt](https://github.com/srand/jolt).

## Architecture

The backend is a gRPC client of the Jolt scheduler. It subscribes to the
scheduler's `Administration.StreamEvents` RPC, which delivers a snapshot of all
queued and running tasks, connected workers and registered builds when the stream is
established, followed by incremental updates.

Because the scheduler is the source of truth and the backend resynchronizes on
every reconnect, the dashboard cannot drift out of sync. Tasks that the
dashboard still believes to be in progress but that are absent from a snapshot
were lost while the backend was disconnected and are terminated.

State is persisted in SQLite and pushed to the browser over separate
`/api/v1/tasks/events` and `/api/v1/workers/events` websockets.

### Browser event streams

The first DATA frame on each websocket is a complete list snapshot:

```json
{"type":"snapshot","items":[]}
```

`items` contains the same task or worker objects as its REST list endpoint; an
empty list is `[]`, not `null`. Subsequent frames are the existing raw task or
worker objects, with `Status: "Deleted"` or `TaskStatus: "Deleted"` marking
removal. Subscriber registration and snapshot capture share the service's
mutation/publication coordinator: a change is represented in the snapshot or
queued after it, never lost in between. The snapshot is detached from database
state and separate from the bounded incremental queue; JSON encoding and socket
writes happen outside mutation locks. Task and worker snapshots are independently
consistent, not one global cross-stream transaction.

The live browser initializes, reconnects, and resumes solely from these ordered
streams, without competing REST list requests that could overwrite newer events.
Previous lists remain visible until each replacement snapshot arrives. REST list
endpoints remain unchanged for other clients. **Deploy the backend and frontend
together:** the snapshot-first websocket contract is not compatible with older
clients or servers expecting only raw incremental frames.

Each browser subscription has a bounded, 10-event queue. Publication never waits
for a slow browser: a full queue evicts that subscription and disconnects its
websocket instead of silently discarding updates. The server attempts a `1013`
(Try Again Later) close frame instructing the browser to resynchronize, even if
the data writer is blocked, then closes the connection after a bounded control
attempt. While live updates are enabled, a browser receiving `1013` promptly
replaces both event streams for fresh snapshots; simultaneous closes
coalesce into one reconnect, and callbacks from superseded sockets are ignored.
If the close frame cannot be delivered, the ordinary
disconnect path reconnects after ten seconds. Pausing or unmounting
cancels pending reconnects; resuming updates establishes fresh snapshot-first
streams. Invalid frames or updates received before a snapshot are rejected and
trigger ordinary reconnect recovery rather than being buffered in the browser.

## Build Attribution

Submit attribution through configuration parameters:

```sh
jolt -c params.username=alice -c params.origin="$BUILD_URL" build --network my-task
```

Jolt exports these as `config.username` and `config.origin`. The dashboard consumes
generic administration build events, but only stores and exposes these two exact
allowlisted parameters. It never stores or exposes the raw parameter list, task
graph, recipes or full environment. Attribution is client-supplied and unverified;
neither username nor origin is inferred. Do not put secrets in parameters: the
scheduler forwards **all** parameters to administration subscribers, even though
the dashboard discards other keys.

Build metadata is stored once per scheduler build ID, with status and scheduled
time. Tasks reference it via an indexed build ID. REST `/api/v1/tasks` and websocket
`/api/v1/tasks/events` task objects have the same representation (alongside unchanged
task fields):

```json
{
  "id": "task-instance-uuid",
  "BuildId": "scheduler-build-id",
  "Build": {
    "Id": "scheduler-build-id",
    "Status": "BUILD_ACCEPTED",
    "Scheduled": "2026-10-26 12:00:00.123",
    "Username": "alice",
    "Origin": "https://ci.example.com/build/123",
    "Registered": true
  }
}
```

`Build` is `null` when no metadata is known, including with older schedulers.
Existing historical tasks migrate with `BuildId: ""` and `Build: null`; there is
no attribution inference or task-level attribution column. Missing build values
are empty strings. Build status uses the protocol enum name and is independent
of `Registered`: cancellation/completion does not itself unregister a build or
describe individual task success/failure.

Snapshot builds are upserted before tasks under one shared task/build coordinator,
with mutations and final-view selection in one transaction. Only after commit is
each affected task broadcast once with its final reconciled state and metadata;
SQL failures roll back so retrying cannot lose unpublished history or cancellations.
Incremental task and build updates also select their final views transactionally,
then publish after commit. Build updates refresh and broadcast associated task views,
including an open details dialog. Task reads, deletion, and retention share this
boundary so they cannot interleave snapshot phases or publish stale fanout after
deletion. Snapshots only enumerate
registered builds: absence or a removal event marks a build unregistered but
keeps its metadata while retained tasks reference it. The existing task retention
rules remain 48 hours after queueing or one hour after ending. Periodic cleanup
deletes only unregistered builds with no remaining tasks; registered builds with
no tasks are kept. This adds no independent long-lived build history.

The task list shows compact Origin and Username columns with full values on hover.
Use the Columns button above the grid to choose visible task columns. These choices
(including Hide from a column menu) are remembered across page refreshes in this
browser's local storage, separately for each dashboard origin. They do not sync
between browsers or devices; clearing site data resets them. If storage is unavailable,
column selection still works for the current view but cannot be saved.
The details/log action remains available before a log exists and shows full
attribution in a keyboard-focusable, horizontally scrollable region. Values stay
on one line so long URLs and multiline input cannot squeeze the log pane; original
text remains available on hover. Missing values display as empty strings. Only valid absolute
HTTP(S) origins are clickable, using `target="_blank"` and
`rel="noopener noreferrer"`. Other origins and all usernames (including emails
and URL-shaped usernames) remain safely escaped text.

An open details dialog keeps the task's last observed full object if deletion,
retention, or a replacement snapshot removes its row. This includes recently
cleared attribution and updates followed by removal in one React batch. The
dialog shows `Task is no longer in the current list` without inventing a new task
status, restarting log fetching, or discarding loaded output. Filtering a row
out does not count as removal; if the row returns, its details update again and
the notice disappears. Only the selected task is retained, not a browser-side
task history.

## Configuration

| Environment variable | Description | Default |
| --- | --- | --- |
| `JOLT_SCHEDULER_URI` | gRPC URI of the scheduler | `tcp://jolt-scheduler:9090` |
| `PORT` | Port to serve the web application on | `8080` |

## Development

```sh
cd backend && go build ./... && go test ./...
cd frontend && npm install && npm run build
```

The backend serves the built frontend from `static/`.

### Generating load

Run a scheduler locally and drive it with `schedulerctl` from the Jolt
repository:

```sh
schedulerctl -s tcp://localhost:9090 mock build -t task1 -t task2
```

Use `schedulerctl events` to inspect the same stream the dashboard consumes.

### Regenerating the protocol stubs

The scheduler protocol stubs in `backend/protocol` are vendored. See
`backend/protocol/generate.sh`.
