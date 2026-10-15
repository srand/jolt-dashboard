# Streaming Task Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task log opened in the dashboard keeps appending lines as the task writes them, and ends by itself when the task finishes.

**Architecture:** logstash gains an opt-in follow mode: a reader that blocks instead of returning EOF while a writer is still open, woken by the writer. Both logstash APIs expose it (`follow` on `ReadLogRequest`, `?follow=1` on the HTTP route), the dashboard proxies the streaming response byte for byte, and the log dialog consumes it incrementally.

**Tech Stack:** Go 1.25 (`testify` suite tests, `echo` v4, `afero`, `gob`, gRPC), React 18 with MUI 5 and CRA/jest.

**Spec:** `docs/superpowers/specs/2026-10-14-streaming-task-logs-design.md` (in the `jolt-dashboard` repo)

## Repositories

Two working trees. Every task says which one it is in.

- `jolt` — `/home/rbrt/git/jolt`. Go module root is `/home/rbrt/git/jolt/services`. Tasks 1-4.
- `jolt-dashboard` — `/home/rbrt/git/jolt-dashboard`, branch `streaming-task-logs`. Tasks 5-7.

Tasks 1-4 are a self-contained change to `jolt` and must land before Task 5 does anything useful. Commit in each repo separately.

## Global Constraints

- Follow mode is opt-in everywhere. A request without `follow` behaves exactly as it does today. Verbatim from the spec: "Existing log consumers keep their current behaviour, unchanged and unslowed."
- The dashboard gets no new protocol stubs and no new configuration.
- The log line text format is unchanged: `2006-01-02 15:04:05.000000 [  LEVEL] message`. The frontend filters by fixed columns (`line[27]`, `line.slice(28, 35)`), so any change to spacing breaks filtering.
- A follow read never returns `(0, nil)`. `gob` reads through `io.ReadFull`, which treats that as "try again" and spins.
- Terminal task statuses in the dashboard are `Passed`, `Failed`, `Cancelled`, `Deleted`. Non-terminal are `Queued`, `Assigned`, `Running`.
- Go module commands run from `/home/rbrt/git/jolt/services` or `/home/rbrt/git/jolt-dashboard/backend`; there is no module at either repo root.

## Review Focus

Five conditions the spec implies that no single task's happy path exercises. Each has a test assigned to the task that owns the code.

1. **A log line longer than the proxy's read buffer**, so a chunk boundary lands mid-line: the browser must not render a half line. Tested in Task 5 (proxy splits, bytes still arrive intact) and Task 6 (a chunk with no newline at all emits nothing).
2. **Two followers on one log, one closing early**: the other must keep receiving lines. Tested in Task 2.
3. **`follow` on a log that is already complete**: must return the whole log and end, not hang forever. Tested in Task 2 and Task 4.
4. **The client disappearing mid-stream**: no blocked goroutine, no leaked file handle, and the upstream request cancelled. Tested in Task 2 (context cancel) and Task 5 (upstream sees cancellation).
5. **A multi-byte UTF-8 character split across two chunks**: one `TextDecoder` instance must be reused across chunks, or the character is corrupted. Tested in Task 6.

---

### Task 1: Writer tracking in logstash

A log id needs to know how many writers are open and how to wake readers. Nothing observable changes yet.

**Repository:** `jolt`

**Files:**
- Modify: `services/pkg/logstash/logstash.go` (the `logStash` struct, `NewLogStash`, `Append`, `logClosed`)
- Modify: `services/pkg/logstash/log_writer.go` (carry the id, notify on write)
- Test: `services/pkg/logstash/logstash_test.go` (append to the existing suite)

**Interfaces:**
- Consumes: nothing.
- Produces, all unexported, all on `*logStash`:
  - `watch(id string) (<-chan struct{}, bool)` — the current notify channel and whether the log is drained (no writers). Returns `(nil, true)` for an unknown id.
  - `logWritten(id string)` — wake waiters; a no-op when no follower is registered.
  - `addFollower(id string)` / `dropFollower(id string)`.
  - `newFileLogWriter(stash *logStash, file utils.File, id string) *fileLogWriter` — gains the `id` parameter.

- [ ] **Step 1: Write the failing test**

Append to `services/pkg/logstash/logstash_test.go`:

```go
func (s *LogStashTestSuite) TestWatchReportsDrainedForUnknownLog() {
	stash := s.stash.(*logStash)

	notify, drained := stash.watch("nosuchlog")
	assert.Nil(s.T(), notify)
	assert.True(s.T(), drained)
}

func (s *LogStashTestSuite) TestWatchTracksOpenWriters() {
	stash := s.stash.(*logStash)

	first, err := stash.Append("log1")
	assert.NoError(s.T(), err)

	_, drained := stash.watch("log1")
	assert.False(s.T(), drained)

	second, err := stash.Append("log1")
	assert.NoError(s.T(), err)
	assert.NoError(s.T(), first.Close())

	// One writer is still open, so the log is not drained.
	_, drained = stash.watch("log1")
	assert.False(s.T(), drained)

	assert.NoError(s.T(), second.Close())

	_, drained = stash.watch("log1")
	assert.True(s.T(), drained)
}

func (s *LogStashTestSuite) TestWriteWakesWaiters() {
	stash := s.stash.(*logStash)

	writer, err := stash.Append("log1")
	assert.NoError(s.T(), err)
	defer writer.Close()

	// A registered follower is what makes notification observable.
	stash.addFollower("log1")
	defer stash.dropFollower("log1")

	notify, _ := stash.watch("log1")
	s.writeLines(writer, "line", 1)

	select {
	case <-notify:
	case <-time.After(2 * time.Second):
		s.T().Fatal("writing a line did not wake waiters")
	}
}

func (s *LogStashTestSuite) TestLastWriterCloseWakesWaiters() {
	stash := s.stash.(*logStash)

	writer, err := stash.Append("log1")
	assert.NoError(s.T(), err)

	stash.addFollower("log1")
	defer stash.dropFollower("log1")

	notify, _ := stash.watch("log1")
	assert.NoError(s.T(), writer.Close())

	select {
	case <-notify:
	case <-time.After(2 * time.Second):
		s.T().Fatal("closing the last writer did not wake waiters")
	}
}

func (s *LogStashTestSuite) TestWritingWithoutFollowersDoesNotBlock() {
	stash := s.stash.(*logStash)

	writer, err := stash.Append("log1")
	assert.NoError(s.T(), err)

	// Nobody is following, so notification must do nothing at all. If this
	// ever blocks or panics, every task on the scheduler pays for it.
	done := make(chan struct{})
	go func() {
		s.writeLines(writer, "line", 1000)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		s.T().Fatal("writing lines blocked with no follower registered")
	}

	assert.NoError(s.T(), writer.Close())
}

func (s *LogStashTestSuite) TestStreamStateIsReleasedWhenIdle() {
	stash := s.stash.(*logStash)

	writer, err := stash.Append("log1")
	assert.NoError(s.T(), err)
	assert.NoError(s.T(), writer.Close())

	stash.Lock()
	_, tracked := stash.streams["log1"]
	stash.Unlock()
	assert.False(s.T(), tracked, "stream state leaked after the last writer closed")
}
```

Add `"time"` to the test file's imports.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /home/rbrt/git/jolt/services && go test ./pkg/logstash/ -run TestLogStash -v
```

Expected: compile failure — `stash.watch`, `stash.addFollower`, `stash.dropFollower` and `stash.streams` are undefined.

- [ ] **Step 3: Add the registry to `logstash.go`**

Add the type next to `logStash`:

```go
// Tracks the writers and followers of a single log, so that a follow reader
// can tell "nothing written yet" from "nothing will be written".
type logStream struct {
	writers   int
	followers int
	notify    chan struct{}
}
```

Add the field to `logStash`:

```go
type logStash struct {
	mu      utils.RWMutex
	config  LogStashConfig
	fs      utils.Fs
	lru     *utils.LRU[*logFile]
	streams map[string]*logStream
}
```

Initialise it in `NewLogStash`, alongside the existing fields:

```go
	stash := &logStash{
		mu:      utils.NewRWMutex(),
		config:  config,
		fs:      fs,
		streams: map[string]*logStream{},
	}
```

Add the registry helpers at the end of the file:

```go
// Returns the tracking state for id, creating it if absent.
// Callers must hold s.mu.
func (s *logStash) streamLocked(id string) *logStream {
	stream, ok := s.streams[id]
	if !ok {
		stream = &logStream{notify: make(chan struct{})}
		s.streams[id] = stream
	}
	return stream
}

// Wakes everything waiting on the stream by closing the channel it handed out,
// then installs a fresh one for the next wait. Callers must hold s.mu.
func (s *logStash) wakeLocked(stream *logStream) {
	close(stream.notify)
	stream.notify = make(chan struct{})
}

// Forgets a stream once nothing refers to it. Callers must hold s.mu.
func (s *logStash) releaseLocked(id string, stream *logStream) {
	if stream.writers == 0 && stream.followers == 0 {
		delete(s.streams, id)
	}
}

// Returns the channel to wait on for more data, and whether the log is
// drained: no writer is open, so what is on disk is all there will ever be.
func (s *logStash) watch(id string) (<-chan struct{}, bool) {
	s.Lock()
	defer s.Unlock()

	stream, ok := s.streams[id]
	if !ok {
		return nil, true
	}

	return stream.notify, stream.writers == 0
}

func (s *logStash) addFollower(id string) {
	s.Lock()
	defer s.Unlock()
	s.streamLocked(id).followers++
}

func (s *logStash) dropFollower(id string) {
	s.Lock()
	defer s.Unlock()

	stream, ok := s.streams[id]
	if !ok {
		return
	}

	stream.followers--
	s.releaseLocked(id, stream)
}

// Called after every log line. Runs on the hot path, so it does nothing at all
// unless somebody is actually following the log.
func (s *logStash) logWritten(id string) {
	s.Lock()
	defer s.Unlock()

	stream, ok := s.streams[id]
	if !ok || stream.followers == 0 {
		return
	}

	s.wakeLocked(stream)
}
```

- [ ] **Step 4: Register writers in `Append` and `logClosed`**

In `Append`, after the existing LRU removal, replace:

```go
	s.Lock()
	s.lru.Remove(id)
	s.Unlock()

	log.Debug("add - log - id:", id)

	return newFileLogWriter(s, file), nil
```

with:

```go
	s.Lock()
	s.lru.Remove(id)
	s.streamLocked(id).writers++
	s.Unlock()

	log.Debug("add - log - id:", id)

	return newFileLogWriter(s, file, id), nil
```

Replace `logClosed` entirely:

```go
func (s *logStash) logClosed(writer *fileLogWriter) {
	s.Lock()
	defer s.Unlock()

	s.lru.Add(newLogFile(s.fs, writer.Path()))

	stream, ok := s.streams[writer.id]
	if !ok {
		return
	}

	stream.writers--
	if stream.writers == 0 {
		// Wake followers so they can see that the log is finished.
		s.wakeLocked(stream)
	}
	s.releaseLocked(writer.id, stream)
}
```

- [ ] **Step 5: Carry the id on the writer and notify on write**

In `log_writer.go`, replace the struct, constructor and `WriteLine`:

```go
type fileLogWriter struct {
	file    utils.File
	encoder *gob.Encoder
	stash   *logStash
	id      string
}

func newFileLogWriter(stash *logStash, file utils.File, id string) *fileLogWriter {
	return &fileLogWriter{
		file:    file,
		encoder: gob.NewEncoder(file),
		stash:   stash,
		id:      id,
	}
}

func (r *fileLogWriter) WriteLine(line *protocol.LogLine) error {
	if err := r.encoder.Encode(line); err != nil {
		return err
	}

	r.stash.logWritten(r.id)
	return nil
}
```

The id is carried explicitly rather than derived from `file.Name()`, because `afero.BasePathFs` rewrites names.

`Close` and `Path` are unchanged.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd /home/rbrt/git/jolt/services && go test ./pkg/logstash/ -run TestLogStash -v
```

Expected: PASS, including the pre-existing `TestWriteRead`, `TestEvict`, `TestActiveReopenedLogIsNotEvicted`, `TestCreate` and `TestEviction` — they are the evidence that the default path is unchanged.

- [ ] **Step 7: Verify the whole module still builds and passes**

```bash
cd /home/rbrt/git/jolt/services && go build ./... && go test ./...
```

Expected: no build errors, tests pass.

- [ ] **Step 8: Commit**

```bash
cd /home/rbrt/git/jolt
git add services/pkg/logstash/logstash.go services/pkg/logstash/log_writer.go services/pkg/logstash/logstash_test.go
git commit -m "logstash: track open writers and followers per log"
```

---

### Task 2: The follow reader

A reader that blocks at end of log while a writer is open, and ends when the last one closes.

**Repository:** `jolt`

**Files:**
- Create: `services/pkg/logstash/log_reader_follow.go`
- Modify: `services/pkg/logstash/logstash.go` (the `LogStash` interface, add `Follow`)
- Test: `services/pkg/logstash/log_reader_follow_test.go`

**Interfaces:**
- Consumes: `(*logStash).watch`, `addFollower`, `dropFollower`, `logWritten` from Task 1.
- Produces: `LogStash.Follow(ctx context.Context, id string) (LogReader, error)` on the interface. Returns the same error `Read` does when the log does not exist. The returned `LogReader` has the existing `ReadLine() (*protocol.LogLine, error)` / `Close() error` shape.

- [ ] **Step 1: Write the failing tests**

Create `services/pkg/logstash/log_reader_follow_test.go`:

```go
package logstash

import (
	"bytes"
	"context"
	"encoding/gob"
	"io"
	"os"
	"testing"
	"time"

	"github.com/spf13/afero"
	"github.com/srand/jolt/scheduler/pkg/protocol"
	"github.com/srand/jolt/scheduler/pkg/utils"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/suite"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type FollowTestSuite struct {
	suite.Suite
	config MockLogStashConfig
	fs     utils.Fs
	stash  *logStash
}

func (s *FollowTestSuite) SetupTest() {
	s.config.On("MaxSize").Return(0x100000)
	s.fs = afero.NewMemMapFs()
	s.stash = NewLogStash(&s.config, s.fs).(*logStash)
}

func (s *FollowTestSuite) line(message string) *protocol.LogLine {
	return &protocol.LogLine{
		Level:   protocol.LogLevel_INFO,
		Time:    timestamppb.Now(),
		Message: message,
	}
}

// Reads one line in the background so the test can assert on whether the read
// blocked.
func (s *FollowTestSuite) readAsync(reader LogReader) chan *protocol.LogLine {
	out := make(chan *protocol.LogLine, 1)
	go func() {
		line, err := reader.ReadLine()
		if err != nil {
			out <- nil
			return
		}
		out <- line
	}()
	return out
}

func (s *FollowTestSuite) TestFollowEndsImmediatelyOnCompletedLog() {
	writer, err := s.stash.Append("log1")
	assert.NoError(s.T(), err)
	assert.NoError(s.T(), writer.WriteLine(s.line("only")))
	assert.NoError(s.T(), writer.Close())

	reader, err := s.stash.Follow(context.Background(), "log1")
	assert.NoError(s.T(), err)
	defer reader.Close()

	line, err := reader.ReadLine()
	assert.NoError(s.T(), err)
	assert.Equal(s.T(), "only", line.Message)

	_, err = reader.ReadLine()
	assert.Equal(s.T(), io.EOF, err)
}

func (s *FollowTestSuite) TestFollowReturnsErrorForMissingLog() {
	_, err := s.stash.Follow(context.Background(), "nosuchlog")
	assert.Error(s.T(), err)

	s.stash.Lock()
	_, tracked := s.stash.streams["nosuchlog"]
	s.stash.Unlock()
	assert.False(s.T(), tracked, "a failed Follow leaked stream state")
}

func (s *FollowTestSuite) TestFollowBlocksThenDeliversNewLine() {
	writer, err := s.stash.Append("log1")
	assert.NoError(s.T(), err)
	assert.NoError(s.T(), writer.WriteLine(s.line("first")))

	reader, err := s.stash.Follow(context.Background(), "log1")
	assert.NoError(s.T(), err)
	defer reader.Close()

	line, err := reader.ReadLine()
	assert.NoError(s.T(), err)
	assert.Equal(s.T(), "first", line.Message)

	pending := s.readAsync(reader)

	select {
	case <-pending:
		s.T().Fatal("ReadLine returned at end of log while a writer was open")
	case <-time.After(100 * time.Millisecond):
	}

	assert.NoError(s.T(), writer.WriteLine(s.line("second")))

	select {
	case line := <-pending:
		assert.NotNil(s.T(), line)
		assert.Equal(s.T(), "second", line.Message)
	case <-time.After(2 * time.Second):
		s.T().Fatal("ReadLine did not resume after a line was written")
	}

	assert.NoError(s.T(), writer.Close())
}

func (s *FollowTestSuite) TestFollowEndsWhenLastWriterCloses() {
	first, err := s.stash.Append("log1")
	assert.NoError(s.T(), err)
	second, err := s.stash.Append("log1")
	assert.NoError(s.T(), err)

	reader, err := s.stash.Follow(context.Background(), "log1")
	assert.NoError(s.T(), err)
	defer reader.Close()

	pending := s.readAsync(reader)
	assert.NoError(s.T(), first.Close())

	select {
	case <-pending:
		s.T().Fatal("ReadLine ended while a second writer was still open")
	case <-time.After(100 * time.Millisecond):
	}

	assert.NoError(s.T(), second.Close())

	select {
	case line := <-pending:
		assert.Nil(s.T(), line, "expected end of stream, got a line")
	case <-time.After(2 * time.Second):
		s.T().Fatal("ReadLine did not end after the last writer closed")
	}
}

// Review Focus 2.
func (s *FollowTestSuite) TestOneFollowerClosingDoesNotEndAnother() {
	writer, err := s.stash.Append("log1")
	assert.NoError(s.T(), err)
	assert.NoError(s.T(), writer.WriteLine(s.line("first")))
	defer writer.Close()

	keep, err := s.stash.Follow(context.Background(), "log1")
	assert.NoError(s.T(), err)
	defer keep.Close()

	leave, err := s.stash.Follow(context.Background(), "log1")
	assert.NoError(s.T(), err)

	line, err := keep.ReadLine()
	assert.NoError(s.T(), err)
	assert.Equal(s.T(), "first", line.Message)
	assert.NoError(s.T(), leave.Close())

	pending := s.readAsync(keep)
	assert.NoError(s.T(), writer.WriteLine(s.line("second")))

	select {
	case line := <-pending:
		assert.NotNil(s.T(), line)
		assert.Equal(s.T(), "second", line.Message)
	case <-time.After(2 * time.Second):
		s.T().Fatal("the surviving follower stopped receiving lines")
	}
}

// Review Focus 4.
func (s *FollowTestSuite) TestFollowUnblocksOnContextCancel() {
	writer, err := s.stash.Append("log1")
	assert.NoError(s.T(), err)
	assert.NoError(s.T(), writer.WriteLine(s.line("first")))
	defer writer.Close()

	ctx, cancel := context.WithCancel(context.Background())

	reader, err := s.stash.Follow(ctx, "log1")
	assert.NoError(s.T(), err)
	defer reader.Close()

	_, err = reader.ReadLine()
	assert.NoError(s.T(), err)

	pending := s.readAsync(reader)
	cancel()

	select {
	case <-pending:
	case <-time.After(2 * time.Second):
		s.T().Fatal("a cancelled context left ReadLine blocked")
	}
}

// The reason this design blocks underneath the decoder instead of retrying it:
// a gob record that is only half written must not desync the decoder.
func (s *FollowTestSuite) TestFollowDecodesRecordSplitAcrossWaits() {
	// Produce a byte stream holding two records, and find a split point inside
	// the second one.
	var buf bytes.Buffer
	encoder := gob.NewEncoder(&buf)
	assert.NoError(s.T(), encoder.Encode(s.line("first")))
	mark := buf.Len()
	assert.NoError(s.T(), encoder.Encode(s.line("second")))

	all := buf.Bytes()
	split := mark + (len(all)-mark)/2

	// Register a writer so follow mode blocks, but write the bytes by hand.
	writer, err := s.stash.Append("log1")
	assert.NoError(s.T(), err)

	file, err := s.fs.OpenFile("log1", os.O_WRONLY, 0644)
	assert.NoError(s.T(), err)
	defer file.Close()

	_, err = file.Write(all[:split])
	assert.NoError(s.T(), err)
	s.stash.logWritten("log1")

	reader, err := s.stash.Follow(context.Background(), "log1")
	assert.NoError(s.T(), err)
	defer reader.Close()

	line, err := reader.ReadLine()
	assert.NoError(s.T(), err)
	assert.Equal(s.T(), "first", line.Message)

	pending := s.readAsync(reader)

	select {
	case <-pending:
		s.T().Fatal("ReadLine returned from a half-written record")
	case <-time.After(100 * time.Millisecond):
	}

	_, err = file.Write(all[split:])
	assert.NoError(s.T(), err)
	s.stash.logWritten("log1")

	select {
	case line := <-pending:
		assert.NotNil(s.T(), line, "the decoder desynced on the split record")
		assert.Equal(s.T(), "second", line.Message)
	case <-time.After(2 * time.Second):
		s.T().Fatal("ReadLine did not resume once the record was complete")
	}

	assert.NoError(s.T(), writer.Close())
}

func TestFollow(t *testing.T) {
	suite.Run(t, &FollowTestSuite{})
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /home/rbrt/git/jolt/services && go test ./pkg/logstash/ -run TestFollow -v
```

Expected: compile failure — `Follow` is not defined on `*logStash`.

- [ ] **Step 3: Write the follow reader**

Create `services/pkg/logstash/log_reader_follow.go`:

```go
package logstash

import (
	"context"
	"encoding/gob"
	"io"

	"github.com/srand/jolt/scheduler/pkg/protocol"
	"github.com/srand/jolt/scheduler/pkg/utils"
)

// Reads a log file like any other reader, except that reaching the end of the
// file is not the end of the stream while a writer is still open: the read
// blocks until more bytes arrive.
//
// The blocking belongs here, underneath the gob decoder, rather than in a retry
// loop around it. A decoder that reads a half-written record fails with
// io.ErrUnexpectedEOF and cannot be resumed, so it must never see a short read.
type tailReader struct {
	ctx   context.Context
	file  utils.File
	stash *logStash
	id    string
}

func (r *tailReader) Read(p []byte) (int, error) {
	for {
		// Take the channel before reading. A write landing between the read and
		// the wait would otherwise go unnoticed, parking us until the next one.
		notify, drained := r.stash.watch(r.id)

		n, err := r.file.Read(p)
		if n > 0 {
			// Deliver what we have, even when the read also reported EOF.
			return n, nil
		}
		if err != nil && err != io.EOF {
			return 0, err
		}
		if drained {
			return 0, io.EOF
		}

		select {
		case <-notify:
		case <-r.ctx.Done():
			return 0, r.ctx.Err()
		}
	}
}

type followLogReader struct {
	decoder *gob.Decoder
	file    utils.File
	stash   *logStash
	id      string
}

func newFollowLogReader(ctx context.Context, stash *logStash, file utils.File, id string) *followLogReader {
	tail := &tailReader{ctx: ctx, file: file, stash: stash, id: id}

	return &followLogReader{
		decoder: gob.NewDecoder(tail),
		file:    file,
		stash:   stash,
		id:      id,
	}
}

func (r *followLogReader) ReadLine() (*protocol.LogLine, error) {
	var line protocol.LogLine

	if err := r.decoder.Decode(&line); err != nil {
		return nil, err
	}

	return &line, nil
}

func (r *followLogReader) Close() error {
	r.stash.dropFollower(r.id)
	return r.file.Close()
}
```

- [ ] **Step 4: Add `Follow` to the interface and the implementation**

In `logstash.go`, extend the `LogStash` interface:

```go
type LogStash interface {
	// Append a log record to the logstash server
	Append(id string) (LogWriter, error)

	// ReadLog reads a log from the logstash server
	Read(id string) (LogReader, error)

	// Follow reads a log like Read, but does not end the stream while the log
	// is still being written. It ends when the last writer closes, or when ctx
	// is cancelled.
	Follow(ctx context.Context, id string) (LogReader, error)
}
```

Add `"context"` to the file's imports, and the method next to `Read`:

```go
// Follow reads a log, blocking at the end of the file while it is still
// being written.
func (s *logStash) Follow(ctx context.Context, id string) (LogReader, error) {
	id = canonicalLogPath(id)

	// Register before opening, so a writer closing in between still wakes us.
	s.addFollower(id)

	file, err := s.fs.Open(id)
	if err != nil {
		s.dropFollower(id)
		return nil, err
	}

	return newFollowLogReader(ctx, s, file, id), nil
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd /home/rbrt/git/jolt/services && go test ./pkg/logstash/ -v
```

Expected: PASS for both `TestFollow` and `TestLogStash`.

- [ ] **Step 6: Run with the race detector**

```bash
cd /home/rbrt/git/jolt/services && go test ./pkg/logstash/ -race
```

Expected: PASS, no race reports. This matters: readers block on a channel that writers replace under the lock.

- [ ] **Step 7: Commit**

```bash
cd /home/rbrt/git/jolt
git add services/pkg/logstash/log_reader_follow.go services/pkg/logstash/log_reader_follow_test.go services/pkg/logstash/logstash.go
git commit -m "logstash: add a follow mode that tails a log being written"
```

---

### Task 3: `follow` on the gRPC API

**Repository:** `jolt`

**Files:**
- Modify: `services/pkg/logstash/log.proto` (`jolt/plugins/remote_execution/log.proto` is a symlink to it)
- Modify: `services/pkg/protocol/log.pb.go` (generated, do not hand-edit)
- Modify: `services/pkg/logstash/grpc_service.go:24`
- Test: `services/pkg/logstash/grpc_service_test.go`

**Interfaces:**
- Consumes: `LogStash.Follow` from Task 2.
- Produces: `ReadLogRequest.Follow bool` (accessor `GetFollow() bool`) in package `protocol`.

- [ ] **Step 1: Add the proto field**

In `services/pkg/logstash/log.proto`, inside `ReadLogRequest`, after the `before`/`after` fields:

```proto
    // Do not end the stream at the end of the log while it is still being
    // written. The stream ends when the log is complete.
    bool follow = 4;
```

- [ ] **Step 2: Regenerate the Go stubs**

```bash
cd /home/rbrt/git/jolt && ./services/pkg/protocol/generate.sh
git -C /home/rbrt/git/jolt diff --stat services/pkg/protocol/
```

Expected: `services/pkg/protocol/log.pb.go` changes and nothing else does. The script needs `protoc` plus `protoc-gen-go@v1.34.1` and `protoc-gen-go-grpc@v1.3.0` on PATH; it documents this in its header. If `protoc` is missing, stop and tell your human partner rather than hand-editing the generated file.

- [ ] **Step 3: Write the failing test**

Create `services/pkg/logstash/grpc_service_test.go`:

```go
package logstash

import (
	"context"
	"testing"
	"time"

	"github.com/spf13/afero"
	"github.com/srand/jolt/scheduler/pkg/protocol"
	"github.com/stretchr/testify/assert"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Minimal stand-in for protocol.LogStash_ReadLogServer. Embedding the
// grpc.ServerStream interface satisfies the methods the test never calls.
type fakeReadLogStream struct {
	grpc.ServerStream
	ctx       context.Context
	responses chan *protocol.ReadLogResponse
}

func (s *fakeReadLogStream) Context() context.Context {
	return s.ctx
}

func (s *fakeReadLogStream) Send(response *protocol.ReadLogResponse) error {
	s.responses <- response
	return nil
}

func newTestService(t *testing.T) (*LogStashService, LogStash) {
	t.Helper()

	config := new(MockLogStashConfig)
	config.On("MaxSize").Return(0x100000)
	stash := NewLogStash(config, afero.NewMemMapFs())

	return NewLogStashService(stash), stash
}

func testLine(message string) *protocol.LogLine {
	return &protocol.LogLine{
		Level:   protocol.LogLevel_INFO,
		Time:    timestamppb.Now(),
		Message: message,
	}
}

func TestReadLogWithoutFollowEndsAtEndOfLog(t *testing.T) {
	service, stash := newTestService(t)

	writer, err := stash.Append("log1")
	assert.NoError(t, err)
	assert.NoError(t, writer.WriteLine(testLine("first")))
	// Deliberately left open: without follow the stream must still end.
	defer writer.Close()

	stream := &fakeReadLogStream{ctx: context.Background(), responses: make(chan *protocol.ReadLogResponse, 8)}

	done := make(chan error, 1)
	go func() {
		done <- service.ReadLog(&protocol.ReadLogRequest{Id: "log1"}, stream)
	}()

	select {
	case err := <-done:
		assert.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("ReadLog without follow did not end at the end of the log")
	}

	assert.Len(t, stream.responses, 1)
}

func TestReadLogWithFollowStreamsUntilTheLogIsComplete(t *testing.T) {
	service, stash := newTestService(t)

	writer, err := stash.Append("log1")
	assert.NoError(t, err)
	assert.NoError(t, writer.WriteLine(testLine("first")))

	stream := &fakeReadLogStream{ctx: context.Background(), responses: make(chan *protocol.ReadLogResponse, 8)}

	done := make(chan error, 1)
	go func() {
		done <- service.ReadLog(&protocol.ReadLogRequest{Id: "log1", Follow: true}, stream)
	}()

	select {
	case response := <-stream.responses:
		assert.Equal(t, "first", response.Loglines[0].Message)
	case <-time.After(2 * time.Second):
		t.Fatal("the first line never arrived")
	}

	// Written after the request started: this is the point of follow mode.
	assert.NoError(t, writer.WriteLine(testLine("second")))

	select {
	case response := <-stream.responses:
		assert.Equal(t, "second", response.Loglines[0].Message)
	case <-time.After(2 * time.Second):
		t.Fatal("a line written after the request started never arrived")
	}

	select {
	case <-done:
		t.Fatal("ReadLog ended while the log was still being written")
	case <-time.After(100 * time.Millisecond):
	}

	assert.NoError(t, writer.Close())

	select {
	case err := <-done:
		assert.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("ReadLog did not end after the log was complete")
	}
}
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
cd /home/rbrt/git/jolt/services && go test ./pkg/logstash/ -run TestReadLog -v
```

Expected: `TestReadLogWithFollowStreamsUntilTheLogIsComplete` fails — `ReadLog` ignores `Follow`, so it ends before the second line.

- [ ] **Step 5: Honour `follow` in the service**

In `grpc_service.go`, replace the opening of `ReadLog`:

```go
	reader, err := s.stash.Read(req.Id)
	if err != nil {
		return err
	}
	defer reader.Close()
```

with:

```go
	var reader LogReader
	var err error

	if req.GetFollow() {
		reader, err = s.stash.Follow(stream.Context(), req.Id)
	} else {
		reader, err = s.stash.Read(req.Id)
	}
	if err != nil {
		return err
	}
	defer reader.Close()
```

The rest of the function, including the `After`/`Before` filters, is unchanged.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd /home/rbrt/git/jolt/services && go test ./pkg/logstash/ -v && go build ./...
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/rbrt/git/jolt
git add services/pkg/logstash/log.proto services/pkg/protocol/log.pb.go services/pkg/logstash/grpc_service.go services/pkg/logstash/grpc_service_test.go
git commit -m "logstash: add a follow flag to the ReadLog request"
```

Note for your human partner: the checked-in Python stubs (`jolt/plugins/remote_execution/log_pb2.py`) are generated by the `jolt/protobufs` task in `build.jolt`. No Python caller sets `follow`, so they work unchanged; regenerate them separately if you want them in sync.

---

### Task 4: `?follow=1` on the HTTP route, and flush per line

Without the flushing fix a correct follow reader still looks broken: lines sit in net/http's buffer until roughly 4KB accumulates.

**Repository:** `jolt`

**Files:**
- Modify: `services/pkg/logstash/http.go`
- Test: `services/pkg/logstash/http_test.go`

**Interfaces:**
- Consumes: `LogStash.Follow` from Task 2, and the `testLine(message string) *protocol.LogLine` helper defined in Task 3's `grpc_service_test.go` (same package, so Task 3 must land first).
- Produces: `GET /logs/:id?follow=1`. Response stays `text/plain`, chunked, one line per log record, format unchanged.

- [ ] **Step 1: Write the failing test**

Create `services/pkg/logstash/http_test.go`:

```go
package logstash

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
)

func newTestHttpServer(t *testing.T) (*httptest.Server, LogStash) {
	t.Helper()

	config := new(MockLogStashConfig)
	config.On("MaxSize").Return(0x100000)
	stash := NewLogStash(config, afero.NewMemMapFs())

	e := echo.New()
	NewHttpHandler(stash, e)
	server := httptest.NewServer(e)
	t.Cleanup(server.Close)

	return server, stash
}

// Reads one line in the background, so the test can tell "not yet written"
// from "written but stuck in a buffer".
func readLineAsync(reader *bufio.Reader) chan string {
	out := make(chan string, 1)
	go func() {
		line, err := reader.ReadString('\n')
		if err != nil {
			out <- ""
			return
		}
		out <- line
	}()
	return out
}

// The default path: no follow, so the response ends at the end of the log even
// though a writer is still open.
func TestGetLogWithoutFollowEndsAtEndOfLog(t *testing.T) {
	server, stash := newTestHttpServer(t)

	writer, err := stash.Append("log1")
	assert.NoError(t, err)
	assert.NoError(t, writer.WriteLine(testLine("first")))
	defer writer.Close()

	response, err := http.Get(server.URL + "/logs/log1")
	assert.NoError(t, err)
	defer response.Body.Close()
	assert.Equal(t, http.StatusOK, response.StatusCode)

	reader := bufio.NewReader(response.Body)

	select {
	case line := <-readLineAsync(reader):
		assert.Contains(t, line, "first")
	case <-time.After(2 * time.Second):
		t.Fatal("the log line never arrived")
	}

	// The body must end even though a writer is still open.
	select {
	case line := <-readLineAsync(reader):
		assert.Equal(t, "", line)
	case <-time.After(2 * time.Second):
		t.Fatal("a plain read did not end at the end of the log")
	}
}

func TestGetLogWithFollowStreamsLinesAsTheyAreWritten(t *testing.T) {
	server, stash := newTestHttpServer(t)

	writer, err := stash.Append("log1")
	assert.NoError(t, err)
	assert.NoError(t, writer.WriteLine(testLine("first")))

	response, err := http.Get(server.URL + "/logs/log1?follow=1")
	assert.NoError(t, err)
	defer response.Body.Close()
	assert.Equal(t, http.StatusOK, response.StatusCode)

	reader := bufio.NewReader(response.Body)

	select {
	case line := <-readLineAsync(reader):
		assert.Contains(t, line, "first")
	case <-time.After(2 * time.Second):
		t.Fatal("the first line never arrived; is the response being buffered?")
	}

	assert.NoError(t, writer.WriteLine(testLine("second")))

	select {
	case line := <-readLineAsync(reader):
		assert.Contains(t, line, "second")
	case <-time.After(2 * time.Second):
		t.Fatal("a line written after the request started never arrived")
	}

	assert.NoError(t, writer.Close())

	select {
	case line := <-readLineAsync(reader):
		assert.Equal(t, "", line)
	case <-time.After(2 * time.Second):
		t.Fatal("the response did not end once the log was complete")
	}
}

// Review Focus 3: following a log nothing is writing any more must end, not hang.
func TestGetLogWithFollowEndsOnACompletedLog(t *testing.T) {
	server, stash := newTestHttpServer(t)

	writer, err := stash.Append("log1")
	assert.NoError(t, err)
	assert.NoError(t, writer.WriteLine(testLine("first")))
	assert.NoError(t, writer.Close())

	response, err := http.Get(server.URL + "/logs/log1?follow=1")
	assert.NoError(t, err)
	defer response.Body.Close()

	reader := bufio.NewReader(response.Body)

	select {
	case line := <-readLineAsync(reader):
		assert.Contains(t, line, "first")
	case <-time.After(2 * time.Second):
		t.Fatal("the log line never arrived")
	}

	select {
	case line := <-readLineAsync(reader):
		assert.Equal(t, "", line)
	case <-time.After(2 * time.Second):
		t.Fatal("following a completed log did not end")
	}
}

func TestGetLogPreservesTheLineFormat(t *testing.T) {
	server, stash := newTestHttpServer(t)

	writer, err := stash.Append("log1")
	assert.NoError(t, err)
	assert.NoError(t, writer.WriteLine(testLine("hello")))
	assert.NoError(t, writer.Close())

	response, err := http.Get(server.URL + "/logs/log1")
	assert.NoError(t, err)
	defer response.Body.Close()

	line, err := bufio.NewReader(response.Body).ReadString('\n')
	assert.NoError(t, err)

	// The dashboard filters on these exact columns.
	assert.Equal(t, byte('['), line[27], "column 27 must be the level bracket")
	assert.Equal(t, "INFO", strings.TrimSpace(line[28:35]), "columns 28-35 must be the level")
}
```

Add `"strings"` to the imports.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /home/rbrt/git/jolt/services && go test ./pkg/logstash/ -run TestGetLog -v
```

Expected: `TestGetLogWithFollowStreamsLinesAsTheyAreWritten` fails — `?follow=1` is ignored, so the response ends after the first line.

- [ ] **Step 3: Rewrite the handler**

Replace the body of the route in `services/pkg/logstash/http.go`:

```go
func NewHttpHandler(stash LogStash, r *echo.Echo) http.Handler {
	r.GET("/logs/:id", func(c echo.Context) error {
		var reader LogReader
		var err error

		// Following keeps the response open while the task is still writing.
		if c.QueryParam("follow") == "1" {
			reader, err = stash.Follow(c.Request().Context(), c.Param("id"))
		} else {
			reader, err = stash.Read(c.Param("id"))
		}
		if err != nil {
			return c.String(http.StatusNotFound, err.Error())
		}
		defer reader.Close()

		c.Response().Header().Set(echo.HeaderContentType, echo.MIMETextPlain)
		c.Response().WriteHeader(http.StatusOK)

		for {
			record, err := reader.ReadLine()
			if err == io.EOF {
				return nil
			}

			if err != nil {
				// The status is already sent, so there is nowhere to report
				// this but the log.
				return nil
			}

			// Convert level to string
			level := ""

			switch record.Level {
			case protocol.LogLevel_EXCEPTION:
				level = "EXCEPT"
			default:
				level = record.Level.String()
			}

			ts := record.Time.AsTime().Local()
			line := fmt.Sprintf(
				"%s.%06d [%7s] %s\n",
				ts.Format("2006-01-02 15:04:05"),
				ts.Nanosecond()/1000,
				level,
				record.Message)

			if _, err := c.Response().Write([]byte(line)); err != nil {
				return nil
			}

			// Push the line out now. A bufio.Writer would only move it into
			// net/http's own buffer, where it would wait for ~4KB of company.
			c.Response().Flush()
		}
	})

	return r
}
```

Drop the now-unused `"bufio"` import.

Two behaviour changes beyond follow: a mid-stream read error can no longer be reported as a 500 (the status line is long gone by then), and a client that goes away ends the loop at the first failed write.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /home/rbrt/git/jolt/services && go test ./pkg/logstash/ -v
```

Expected: PASS.

- [ ] **Step 5: Verify the module builds and the full suite is green**

```bash
cd /home/rbrt/git/jolt/services && go build ./... && go test ./... && go vet ./pkg/logstash/
```

- [ ] **Step 6: Commit**

```bash
cd /home/rbrt/git/jolt
git add services/pkg/logstash/http.go services/pkg/logstash/http_test.go
git commit -m "logstash: follow mode and per-line flushing on the http log route"
```

---

### Task 5: Stream through the dashboard proxy

**Repository:** `jolt-dashboard` (branch `streaming-task-logs`)

**Files:**
- Modify: `backend/api/task.go:108-135` (`GetTaskLog`)
- Test: `backend/api/task_test.go` (new file)

**Interfaces:**
- Consumes: the logstash HTTP route from Task 4.
- Produces: `GET /api/v1/tasks/:id/log?follow=1` streams and forwards `follow` upstream; without the parameter the behaviour is what it is today.

- [ ] **Step 1: Write the failing test**

Create `backend/api/task_test.go`:

```go
package api

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/srand/jolt-dashboard/model"
)

// Serves GetTaskLog over a real HTTP server, backed by an in-memory database
// holding one task whose log lives at logURL.
//
// A real server rather than httptest.ResponseRecorder: the handler's whole job
// is to flush as it copies, so the test has to read the response while the
// handler is still writing it. Polling a recorder's buffer from the test
// goroutine would be a data race, and `go test -race` would say so.
func newTestTaskServer(t *testing.T, logURL string) (*httptest.Server, string) {
	t.Helper()

	db := model.NewDatabaseFromDsn("file:" + t.Name() + "?mode=memory&cache=shared")
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}

	instance := uuid.New()
	if err := db.Create(&model.Task{
		Instance: instance,
		Name:     "task",
		Status:   "Running",
		Log:      logURL,
	}); err != nil {
		t.Fatal(err)
	}

	api := NewTaskApi(&model.TaskService{Db: db, Broadcast: model.NewBroadcast()})

	e := echo.New()
	e.GET("/api/v1/tasks/:id/log", api.GetTaskLog)
	server := httptest.NewServer(e)
	t.Cleanup(server.Close)

	return server, "/api/v1/tasks/" + instance.String() + "/log"
}

// Reads one line in the background, so a test can tell "not sent yet" from
// "sent but stuck in a buffer".
func readLineAsync(reader *bufio.Reader) chan string {
	out := make(chan string, 1)
	go func() {
		line, err := reader.ReadString('\n')
		if err != nil {
			out <- ""
			return
		}
		out <- line
	}()
	return out
}

func TestGetTaskLogForwardsFollowUpstream(t *testing.T) {
	queries := make(chan string, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries <- r.URL.RawQuery
		w.Write([]byte("line\n"))
	}))
	defer upstream.Close()

	server, path := newTestTaskServer(t, upstream.URL+"/logs/x")

	response, err := http.Get(server.URL + path + "?follow=1")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()

	select {
	case query := <-queries:
		if query != "follow=1" {
			t.Fatalf("upstream query = %q, want follow=1", query)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("upstream was never called")
	}
}

func TestGetTaskLogWithoutFollowDoesNotForwardIt(t *testing.T) {
	queries := make(chan string, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries <- r.URL.RawQuery
		w.Write([]byte("line\n"))
	}))
	defer upstream.Close()

	server, path := newTestTaskServer(t, upstream.URL+"/logs/x")

	response, err := http.Get(server.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()

	select {
	case query := <-queries:
		if query != "" {
			t.Fatalf("upstream query = %q, want empty", query)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("upstream was never called")
	}
}

func TestGetTaskLogDeliversBytesBeforeUpstreamFinishes(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("first\n"))
		w.(http.Flusher).Flush()
		<-release
		w.Write([]byte("second\n"))
	}))
	defer upstream.Close()

	server, path := newTestTaskServer(t, upstream.URL+"/logs/x")

	response, err := http.Get(server.URL + path + "?follow=1")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	reader := bufio.NewReader(response.Body)

	select {
	case line := <-readLineAsync(reader):
		if !strings.Contains(line, "first") {
			t.Fatalf("first line = %q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the first line was still buffered after 2s")
	}

	close(release)

	select {
	case line := <-readLineAsync(reader):
		if !strings.Contains(line, "second") {
			t.Fatalf("second line = %q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the second line never arrived")
	}
}

// Review Focus 1: a line longer than the proxy's 4096-byte read buffer.
func TestGetTaskLogForwardsLinesLongerThanTheBuffer(t *testing.T) {
	long := strings.Repeat("x", 10000)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(long + "\n"))
	}))
	defer upstream.Close()

	server, path := newTestTaskServer(t, upstream.URL+"/logs/x")

	response, err := http.Get(server.URL + path + "?follow=1")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	line, err := bufio.NewReaderSize(response.Body, 64).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if len(line) != len(long)+1 {
		t.Fatalf("line length = %d, want %d", len(line), len(long)+1)
	}
}

// Review Focus 4: an abandoned dialog must not pin the upstream connection for
// the rest of the task.
func TestGetTaskLogCancelsUpstreamWhenTheClientGoesAway(t *testing.T) {
	cancelled := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("first\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		cancelled <- struct{}{}
	}))
	defer upstream.Close()

	server, path := newTestTaskServer(t, upstream.URL+"/logs/x")

	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+path+"?follow=1", nil)
	if err != nil {
		t.Fatal(err)
	}

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	select {
	case line := <-readLineAsync(bufio.NewReader(response.Body)):
		if !strings.Contains(line, "first") {
			t.Fatalf("first line = %q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the first line never arrived")
	}

	// Stand in for the user closing the dialog.
	cancel()

	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request was not cancelled when the client went away")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /home/rbrt/git/jolt-dashboard/backend && go test ./api/ -v
```

Expected: `TestGetTaskLogForwardsFollowUpstream` and `TestGetTaskLogCancelsUpstreamWhenTheClientGoesAway` fail — `follow` is not forwarded and the request context is ignored.

- [ ] **Step 3: Rewrite `GetTaskLog`**

Replace everything from the `transport :=` line to the end of the function in `backend/api/task.go`:

```go
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true,
		},
	}

	url := task.Log
	if c.QueryParam("follow") == "1" {
		// Ask logstash to hold the response open while the task is writing.
		url += "?follow=1"
	}

	// The request context ties the upstream connection to this client. Without
	// it, a closed dialog would leave the upstream read running for the rest of
	// the task.
	request, err := http.NewRequestWithContext(c.Request().Context(), http.MethodGet, url, nil)
	if err != nil {
		return c.String(http.StatusBadRequest, err.Error())
	}

	client := &http.Client{Transport: transport}
	response, err := client.Do(request)
	if err != nil {
		return c.String(http.StatusBadGateway, err.Error())
	}
	defer response.Body.Close()

	c.Response().Header().Set(echo.HeaderContentType, response.Header.Get("Content-Type"))
	// A buffering reverse proxy is the one deployment where chunked streaming
	// stalls; this asks nginx not to.
	c.Response().Header().Set("X-Accel-Buffering", "no")
	c.Response().WriteHeader(http.StatusOK)

	// Copy by hand rather than with c.Stream: io.Copy leaves the bytes in
	// net/http's buffer, which defeats the point of streaming.
	buf := make([]byte, 4096)
	for {
		n, readErr := response.Body.Read(buf)
		if n > 0 {
			if _, err := c.Response().Write(buf[:n]); err != nil {
				return nil
			}
			c.Response().Flush()
		}
		if readErr != nil {
			return nil
		}
	}
```

`task.Log` has no query string of its own (the scheduler builds it as `<logstash>/logs/<instance>`), so appending `?follow=1` is safe.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /home/rbrt/git/jolt-dashboard/backend && go test ./api/ -v
```

Expected: PASS.

- [ ] **Step 5: Verify the backend builds and the whole suite is green**

```bash
cd /home/rbrt/git/jolt-dashboard/backend && go build ./... && go test ./... && go vet ./...
```

- [ ] **Step 6: Commit**

```bash
cd /home/rbrt/git/jolt-dashboard
git add backend/api/task.go backend/api/task_test.go
git commit -m "backend: stream the task log proxy and forward follow upstream"
```

---

### Task 6: Frontend helpers for line buffering and scrolling

The two pieces of real logic behind the dialog, as pure modules that can be tested without a DOM.

**Repository:** `jolt-dashboard`

**Files:**
- Create: `frontend/src/logStream.js`
- Create: `frontend/src/logStream.test.js`
- Create: `frontend/src/scroll.js`
- Create: `frontend/src/scroll.test.js`
- Delete: `frontend/src/App.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createLineBuffer()` → `{ push(chunk: string): string, flush(): string }`. `push` returns only whole lines, each ending in `\n`, and returns `""` when it has none. `flush` returns whatever partial line is left and empties the buffer.
  - `createLogDecoder()` → `{ push(bytes: Uint8Array): string, flush(): string }`. Wraps one `TextDecoder` and one line buffer, so a multi-byte character split across two chunks survives. This is what the dialog uses.
  - `isTerminalStatus(status: string): boolean` — true for `Passed`, `Failed`, `Cancelled`, `Deleted`.
  - `isScrolledToBottom(element: {scrollTop, scrollHeight, clientHeight}, threshold = 24): boolean`.

- [ ] **Step 1: Install the frontend dependencies**

`node_modules` is absent, so nothing can run yet.

```bash
cd /home/rbrt/git/jolt-dashboard/frontend && npm install
```

Expected: `node_modules` appears. `@testing-library/jest-dom` is already in `package.json`, so `src/setupTests.js` will resolve afterwards.

- [ ] **Step 2: Delete the stale CRA template test**

```bash
cd /home/rbrt/git/jolt-dashboard/frontend && git rm src/App.test.js
```

It asserts on boilerplate text (`/learn react/i`) that this dashboard has never rendered, so it fails on any run and would block every "tests pass" gate below. It is Create React App scaffolding that was never adapted, not coverage of anything.

- [ ] **Step 3: Write the failing tests**

Create `frontend/src/logStream.test.js`:

```javascript
import { TextDecoder as NodeTextDecoder } from 'util';

import { createLineBuffer, createLogDecoder, isTerminalStatus } from './logStream';

// jsdom does not define TextDecoder, so borrow node's. createLogDecoder reads
// the global when it is called, not when this module is imported, so assigning
// it here is in time.
global.TextDecoder = global.TextDecoder || NodeTextDecoder;

test('emits nothing until a line is complete', () => {
    const buffer = createLineBuffer();
    expect(buffer.push("2026-10-15 10:00:00.000000 [   INFO] par")).toBe("");
});

test('emits a line once its newline arrives', () => {
    const buffer = createLineBuffer();
    buffer.push("first half ");
    expect(buffer.push("second half\n")).toBe("first half second half\n");
});

test('emits every complete line in a chunk and holds the remainder', () => {
    const buffer = createLineBuffer();
    expect(buffer.push("one\ntwo\nthr")).toBe("one\ntwo\n");
    expect(buffer.push("ee\n")).toBe("three\n");
});

test('emits nothing for an empty chunk', () => {
    const buffer = createLineBuffer();
    expect(buffer.push("")).toBe("");
});

test('flush returns the trailing partial line', () => {
    const buffer = createLineBuffer();
    buffer.push("no newline here");
    expect(buffer.flush()).toBe("no newline here");
    expect(buffer.flush()).toBe("");
});

test('flush returns nothing when every line was complete', () => {
    const buffer = createLineBuffer();
    buffer.push("done\n");
    expect(buffer.flush()).toBe("");
});

// Review Focus 5.
test('a multi-byte character split across chunks survives', () => {
    const decoder = createLogDecoder();

    // "ä" is 0xC3 0xA4, and the chunk boundary falls between its two bytes.
    expect(decoder.push(new Uint8Array([0x61, 0xC3]))).toBe("");
    expect(decoder.push(new Uint8Array([0xA4, 0x0A]))).toBe("a\u00e4\n");
});

test('the decoder flushes a trailing line that never got a newline', () => {
    const decoder = createLogDecoder();

    expect(decoder.push(new Uint8Array([0x61, 0x62]))).toBe("");
    expect(decoder.flush()).toBe("ab");
});

test('terminal statuses are the ones that stop a task', () => {
    expect(isTerminalStatus("Passed")).toBe(true);
    expect(isTerminalStatus("Failed")).toBe(true);
    expect(isTerminalStatus("Cancelled")).toBe(true);
    expect(isTerminalStatus("Deleted")).toBe(true);
    expect(isTerminalStatus("Queued")).toBe(false);
    expect(isTerminalStatus("Assigned")).toBe(false);
    expect(isTerminalStatus("Running")).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
});
```

Create `frontend/src/scroll.test.js`:

```javascript
import { isScrolledToBottom } from './scroll';

test('a view scrolled to the end is at the bottom', () => {
    expect(isScrolledToBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
});

test('a view a few pixels short still counts as the bottom', () => {
    expect(isScrolledToBottom({ scrollTop: 790, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
});

test('a view scrolled up is not at the bottom', () => {
    expect(isScrolledToBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 200 })).toBe(false);
});

test('a view shorter than its container is at the bottom', () => {
    expect(isScrolledToBottom({ scrollTop: 0, scrollHeight: 150, clientHeight: 200 })).toBe(true);
});

test('a missing element is treated as the bottom, so following starts on', () => {
    expect(isScrolledToBottom(null)).toBe(true);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
cd /home/rbrt/git/jolt-dashboard/frontend && CI=true npx react-scripts test --watchAll=false
```

Expected: both suites fail to run — `Cannot find module './logStream'` and `'./scroll'`.

- [ ] **Step 5: Write the modules**

Create `frontend/src/logStream.js`:

```javascript
// The log arrives as a byte stream, so a chunk can end mid-line. The level
// filters in TaskLog index fixed columns, so a half-delivered line must never
// reach the view.
export function createLineBuffer() {
    let pending = "";

    return {
        // Returns the complete lines in this chunk, or "" if there are none.
        push(chunk) {
            pending += chunk;

            const end = pending.lastIndexOf("\n");
            if (end === -1) {
                return "";
            }

            const complete = pending.slice(0, end + 1);
            pending = pending.slice(end + 1);
            return complete;
        },

        // Called when the stream ends, to emit a last line with no newline.
        flush() {
            const rest = pending;
            pending = "";
            return rest;
        },
    };
}

// One TextDecoder for the whole response: a multi-byte character split across
// two chunks is only decoded correctly if the same decoder sees both halves.
export function createLogDecoder() {
    const decoder = new TextDecoder();
    const lines = createLineBuffer();

    return {
        push(bytes) {
            return lines.push(decoder.decode(bytes, { stream: true }));
        },

        flush() {
            return lines.push(decoder.decode()) + lines.flush();
        },
    };
}

const TERMINAL_STATUSES = ["Passed", "Failed", "Cancelled", "Deleted"];

export function isTerminalStatus(status) {
    return TERMINAL_STATUSES.includes(status);
}
```

Create `frontend/src/scroll.js`:

```javascript
// How far from the bottom still counts as "at the bottom", in pixels. Gives
// the user room to be a line off without us fighting their scrolling.
const THRESHOLD = 24;

export function isScrolledToBottom(element, threshold = THRESHOLD) {
    if (!element) {
        return true;
    }

    const { scrollTop, scrollHeight, clientHeight } = element;
    return scrollHeight - scrollTop - clientHeight <= threshold;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd /home/rbrt/git/jolt-dashboard/frontend && CI=true npx react-scripts test --watchAll=false
```

Expected: PASS, 14 tests across two suites, no failing suites.

- [ ] **Step 7: Commit**

```bash
cd /home/rbrt/git/jolt-dashboard
git add frontend/src/logStream.js frontend/src/logStream.test.js frontend/src/scroll.js frontend/src/scroll.test.js
git commit -m "frontend: add log line buffering and scroll helpers

Removes the Create React App template test, which asserted on boilerplate
text this dashboard never rendered."
```

---

### Task 7: Stream into the log dialog

**Repository:** `jolt-dashboard`

**Files:**
- Modify: `frontend/src/TaskLog.js` (whole component)
- Modify: `frontend/src/Tasks.js:103` (`onLogClick`) and `:113-117` (the `TaskLog` element)

**Interfaces:**
- Consumes: `createLogDecoder`, `isTerminalStatus` from `./logStream`; `isScrolledToBottom` from `./scroll`; the streaming proxy from Task 5.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Pass the live task row from `Tasks.js`**

`TaskLog` is handed a snapshot today, so it never learns that the task finished. `Tasks.js` already receives live rows over the tasks websocket.

Replace `onLogClick` (`frontend/src/Tasks.js:103`):

```javascript
  onLogClick(task) {
    this.setState({ logOpen: true, logTaskId: task.id, logTask: task });
  }
```

Replace the `TaskLog` element (`frontend/src/Tasks.js:113-117`) with a version that prefers the current row for this id and falls back to the snapshot taken at click time:

```javascript
        <TaskLog
          open={this.state.logOpen}
          onClose={() => { this.onLogClose(); }}
          task={this.state.filteredRows.find((row) => row.id === this.state.logTaskId) || this.state.logTask}
        />
```

Add `logTaskId: null` next to `logTask` in the constructor's state (`frontend/src/Tasks.js:87-88`).

- [ ] **Step 2: Rewrite `TaskLog.js`**

Replace the file's contents:

```javascript
import React from 'react';

import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from "@mui/icons-material/Close";
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Grid from '@mui/material/Grid';
import IconButton from "@mui/material/IconButton";
import ListItemText from '@mui/material/ListItemText';
import PopoutButton from './PopoutButton';
import ReloadButton from './ReloadButton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

import { createLogDecoder, isTerminalStatus } from './logStream';
import { isScrolledToBottom } from './scroll';

// How long to wait before asking again for a log that does not exist yet. A
// task can be running before its first line is written.
const RETRY_DELAY_MS = 2000;


function Log(props) {
    const log = props.value;

    if (log === "") {
        return (
            <Box
                display="flex"
                justifyContent="center"
                alignItems="center"
                minHeight="50vh"
                minWidth="50vw"
            >
                <CircularProgress flexGrow={1} />
            </Box>
        );
    }

    let logLines = log.split("\n");
    logLines = logLines.filter((line) => {
        return props.filters.includes(line.slice(28, 35).trim()) || (line[27] !== "[" && props.filters.includes("STDOUT"));
    });

    return (
        <pre >{logLines.join("\n")}</pre>
    );
}


class TaskLog extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            filters: ["INFO", "ERROR", "STDOUT", "STDERR"],
            open: props.open,
            task: props.task,
            log: "",
            url: "/api/v1/tasks/" + props.task.id + "/log",
        };

        this.scrollRef = React.createRef();
        // Start following; the user scrolling up turns it off.
        this.following = true;
        this.controller = null;
        this.retryTimer = null;
    }

    componentWillReceiveProps(newProps) {
        if (!this.state.open && newProps.open) {
            var url = "/api/v1/tasks/" + newProps.task.id + "/log";
            this.setState({
                open: newProps.open,
                task: newProps.task,
                url: url,
            });
            this.fetchLog(url, newProps.task);
        } else {
            this.setState({ open: newProps.open, task: newProps.task });

            if (this.state.open && !newProps.open) {
                this.stopFetching();
            }
        }
    }

    componentWillUnmount() {
        this.stopFetching();
    }

    componentDidUpdate() {
        this.scrollToBottomIfFollowing();
    }

    stopFetching() {
        if (this.controller) {
            this.controller.abort();
            this.controller = null;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    scrollToBottomIfFollowing() {
        const element = this.scrollRef.current;
        if (element && this.following) {
            element.scrollTop = element.scrollHeight;
        }
    }

    onScroll() {
        // Stop fighting the user once they scroll up; resume when they come back.
        this.following = isScrolledToBottom(this.scrollRef.current);
    }

    fetchLog(url, task) {
        console.log("Fetching log for " + url);

        this.stopFetching();
        this.following = true;
        this.setState({ log: "" });

        const follow = !isTerminalStatus(task.Status);
        this.streamLog(follow ? url + "?follow=1" : url, task);
    }

    streamLog(url, task) {
        const controller = new AbortController();
        this.controller = controller;

        fetch(url, { signal: controller.signal })
            .then((response) => {
                if (response.status === 404) {
                    // The task may not have written anything yet. Keep asking
                    // while it is still running.
                    if (!isTerminalStatus(this.state.task.Status)) {
                        this.retryTimer = setTimeout(() => {
                            this.retryTimer = null;
                            if (this.controller === controller) {
                                this.streamLog(url, task);
                            }
                        }, RETRY_DELAY_MS);
                    }
                    return;
                }

                return this.consume(response, controller);
            })
            .catch((reason) => {
                if (reason.name !== "AbortError") {
                    console.log(reason);
                }
            });
    }

    consume(response, controller) {
        const reader = response.body.getReader();
        const decoder = createLogDecoder();

        const append = (text) => {
            // Ignore a stream this component has already moved on from.
            if (text !== "" && this.controller === controller) {
                this.setState((prevState) => ({ log: prevState.log + text }));
            }
        };

        const pump = () => {
            return reader.read().then(({ done, value }) => {
                if (done) {
                    append(decoder.flush());
                    return;
                }

                append(decoder.push(value));
                return pump();
            });
        };

        return pump();
    }

    setFilters(filters) {
        this.setState({ filters: filters });
    }

    render() {
        const following = !isTerminalStatus(this.state.task.Status);
        const popoutUrl = following ? this.state.url + "?follow=1" : this.state.url;

        return (
            <Dialog
                open={this.state.open}
                onClose={() => { this.props.onClose(); }}
                aria-labelledby="scroll-dialog-title"
                aria-describedby="scroll-dialog-description"
                display="flex"
                PaperProps={{ sx: { minWidth: "70vw", maxWidth: "70vw", minHeight: "90vh", maxHeight: "90vh", } }}
            >
                <DialogTitle id="scroll-dialog-title">
                    <Box display="flex" alignItems="center">
                      <ListItemText primaryTypographyProps={{variant: "h5"}} primary={this.state.task.Name} secondary={this.state.task.Identity}></ListItemText>
                        <Box>
                            <IconButton onClick={() => { this.props.onClose(); }}>
                                <CloseIcon />
                            </IconButton>
                        </Box>
                    </Box>
                </DialogTitle>
                <Box display="flex" alignItems="center" marginLeft={3} marginRight={3} marginBottom={1}>
                    <Box flexGrow={1} >
                        <Grid container spacing={2}>
                            <Grid item xs={4}>
                                <ListItemText primary={this.state.task.Started} secondary="Started"></ListItemText>
                            </Grid>
                            <Grid item xs={4}>
                                <ListItemText primary={this.state.task.Ended} secondary="Finished"></ListItemText>
                            </Grid>
                            <Grid item xs={4}>
                                <ListItemText primary={this.state.task.Status} secondary="Outcome"></ListItemText>
                            </Grid>
                        </Grid>
                    </Box>
                    <Box display="flex">
                        <Box className="w3-margin-right">
                            <PopoutButton color="primary" href={popoutUrl} />
                        </Box>
                        <Box className="w3-margin-right">
                            <ReloadButton color="primary" onClick={(ev, val) => { this.fetchLog(this.state.url, this.state.task); }} />
                        </Box>
                        <Box>
                            <ToggleButtonGroup value={this.state.filters} onChange={(ev, val) => { this.setFilters(val); }}>
                                <ToggleButton color="primary" value="EXCEPT" >EXCEPT</ToggleButton>
                                <ToggleButton color="primary" value="DEBUG" >DEBUG</ToggleButton>
                                <ToggleButton color="primary" value="VERBOSE" >VERBOSE</ToggleButton>
                                <ToggleButton color="primary" value="INFO" >INFO</ToggleButton>
                                <ToggleButton color="primary" value="ERROR" >ERROR</ToggleButton>
                                <ToggleButton color="primary" value="STDOUT" >STDOUT</ToggleButton>
                                <ToggleButton color="primary" value="STDERR" >STDERR</ToggleButton>
                            </ToggleButtonGroup>
                        </Box>
                    </Box>
                </Box>
                <DialogContent dividers={true} ref={this.scrollRef} onScroll={() => { this.onScroll(); }}>
                    <DialogContentText
                        id="scroll-dialog-description"
                        tabIndex={-1}
                    >
                        <Log value={this.state.log} filters={this.state.filters} />
                    </DialogContentText>
                </DialogContent>
            </Dialog>
        )
    }
}

export default TaskLog;
```

- [ ] **Step 3: Verify the build and the test suite**

```bash
cd /home/rbrt/git/jolt-dashboard/frontend && CI=true npx react-scripts test --watchAll=false && npm run build
```

Expected: tests PASS and the build succeeds with no new warnings about unused imports.

- [ ] **Step 4: Verify by hand against a live scheduler**

The scroll and streaming behaviour needs a real browser; jsdom has no layout and no streaming body.

```bash
# Terminal 1: a scheduler with logstash
cd /home/rbrt/git/jolt && ls services/cmd/scheduler

# Terminal 2: the dashboard, serving the built frontend from static/
cd /home/rbrt/git/jolt-dashboard/backend && go build ./... && JOLT_SCHEDULER_URI=tcp://localhost:9090 ./backend

# Terminal 3: generate a task with a long-running log
schedulerctl -s tcp://localhost:9090 mock build -t task1
```

Confirm, with a task in `Running`:

1. Opening its log shows the lines so far and jumps straight to the bottom.
2. New lines appear without pressing reload, and the view stays at the bottom.
3. Scrolling up stops the view from jumping; scrolling back to the bottom resumes following.
4. When the task completes, the stream ends: no spinner, and the last lines are present.
5. Closing the dialog mid-stream stops the request — the dashboard's own request log shows the `GET .../log` completing.
6. Opening a finished task's log behaves as before.
7. The popout button opens a tab that streams the same log.

A quicker check of the layer underneath, if something looks wrong:

```bash
curl -N 'http://localhost:8080/api/v1/tasks/<instance>/log?follow=1'
```

- [ ] **Step 5: Commit**

```bash
cd /home/rbrt/git/jolt-dashboard
git add frontend/src/TaskLog.js frontend/src/Tasks.js
git commit -m "frontend: stream the task log and follow the tail"
```
