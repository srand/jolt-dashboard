# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A real-time dashboard for [Jolt](https://github.com/srand/jolt): a Go backend that mirrors a Jolt
scheduler into SQLite and pushes it to a React single-page app over websockets.

## Commands

Backend (`backend/`):

```sh
go build ./... && go vet ./... && go test ./...
go test ./model -run TestTaskStatusName    # single test
```

Frontend (`frontend/`, Create React App):

```sh
npm install
CI=true npx react-scripts test --watchAll=false                          # whole suite, non-interactive
CI=true npx react-scripts test --watchAll=false -t "queue time"          # single test by name
CI=true npx react-scripts test --watchAll=false --testPathPattern App    # single file
npm run build                                                            # CI=true turns warnings into errors
```

Running the whole app: the backend serves the built frontend from `static/` relative to its working
directory, and `frontend/package.json` has no `proxy` field, so `npm start` on its own cannot reach
the API. Build the frontend and place it in `static/` next to the backend binary, or use the
`build.jolt` `Run` task, which assembles both and runs on `PORT=8082` against
`JOLT_SCHEDULER_URI=tcp://:9090`. `jolt build` builds the docker image.

Configuration is environment variables: `JOLT_SCHEDULER_URI` (default
`tcp://jolt-scheduler:9090`, `tls://` for TLS), `PORT` (default `8080`), and
`JOLT_SCHEDULER_TOKEN`, `JOLT_CA_CERT` and `JOLT_ALLOW_INSECURE_TOKEN`, which authenticate with
the scheduler like Jolt does (`backend/scheduler/credentials.go`).

The gRPC stubs in `backend/protocol` are vendored; regenerate with `backend/protocol/generate.sh`.

## Architecture

State flows one way, and nothing in the dashboard is authoritative:

```
scheduler --gRPC StreamEvents--> scheduler.Client --> model.TaskService/WorkerService --> SQLite
                                                              |
                                                       model.Broadcast
                                                              |
                                       /api/v1/events websocket --> App.state --> render
```

- **The scheduler is the source of truth.** Every reconnect delivers a full snapshot, which is
  reconciled against the database; anything the dashboard believed was in progress but that is
  absent from the snapshot was lost while disconnected and is terminated. This is why the dashboard
  cannot drift, and why reconciliation logic belongs in `scheduler/client.go`, not in the API layer.
- **Tasks, workers and builds have separate `Broadcast` instances** (`TaskService.Broadcast`,
  `WorkerService.Broadcast`, `BuildService.Updates`). `model.Subscribe` registers a consumer on all
  three and takes their snapshots together, holding the task coordinator (which also guards builds)
  and then the worker coordinator, so the combined snapshot is consistent. The `/api/v1/events`
  websocket's first DATA frame is `{"type":"snapshot","tasks":[...],"workers":[...],"builds":[...]}`
  (empty lists use `[]`), then `{"type":"task"|"worker"|"build","item":{...}}` updates with the
  existing `Deleted` markers (`Status`, or `TaskStatus` for workers). `Subscription.Events` merges
  the three queues into one unbuffered channel, so a slow browser still backs up into the queues
  that detect it. Build changes publish both the affected task views and the build itself, after
  commit. JSON and socket writes must remain outside mutation locks. The older per-list streams
  `/api/v1/{tasks,workers}/events` (first frame `{"type":"snapshot","items":[...]}`) and the REST
  lists remain for other clients; deploy backend and frontend together.
  `Broadcast.Send` never waits for subscriber capacity: a full
  10-event queue evicts that client and signals `Overflow()`. The shared API websocket handler
  attempts close code `1013`, then closes the socket even if the data writer is blocked. With live
  updates enabled, `App` promptly replaces the socket for a fresh snapshot on `1013`;
  other closes retain a ten-second delay. Reconnects coalesce and are cancelled on pause/unmount.
  Initial load, reconnect, and resume use only the websocket stream, never competing REST
  list requests. Old lists stay visible until the replacement snapshot arrives; stale socket callbacks
  are ignored, and invalid/pre-snapshot frames trigger ordinary reconnect recovery.
  A slow browser must never stall the scheduler stream.
- **Stopping builds:** `POST /api/v1/builds/{id}/cancel` forwards the user's bearer ID token to the
  scheduler's `CancelBuild` on a short-lived connection; the scheduler decides (owners and admins).
  The frontend signs in with authorization code + PKCE (`frontend/src/auth.js`), configured by
  `GET /api/v1/auth`. App fetches it once on load to decide whether to offer signing in; it is the
  only REST request of the initial load, and not a list request, so it can't race the snapshot.
  `App.test.js` mocks `auth.loadConfig`, so its fetch assertions keep covering list and log requests.
- **SQLite is a single writer**: the pool is pinned to one connection with WAL and `busy_timeout`
  (`model/database.go`). Don't introduce concurrent writers or a second pool.
- **Timestamps cross the wire as preformatted local-time strings** (`"2006-01-02 15:04:05.999"`,
  `model.FormatTime`), because the browser parses them with `new Date(...)`. Any duration is
  therefore computed by parsing strings on whichever side needs it.
- **Task status strings are the UI's vocabulary** — `Queued`, `Assigned`, `Running`, `Passed`,
  `Failed`, `Cancelled` — produced by `model.TaskStatusName` from the protocol enums. Backend
  queries, frontend filters and the metrics all key off these strings, so adding a status means
  touching all three.
- Tasks are garbage collected by a ticker in `model/task.go`: 48h after being queued, 1h after
  ending.
- `/api/v1/statistics` and `model/statistics.go` exist but the frontend does not use them; it
  computes its own metrics. Don't assume that endpoint is exercised.
- `/api/v1/tasks/:id/log` reverse-proxies the task's logstash URL with a hand-written flush loop,
  forwards the upstream status (the browser's retry depends on seeing a real 404) and sets
  `X-Accel-Buffering: no`. The design notes are in `docs/superpowers/specs/` and the plan in
  `docs/superpowers/plans/`.

### Frontend

Class components throughout, no hooks. `App` owns the lists (`tasks`, `workers`), `updating`, and
one `selectedTask` full view, and passes them down. `Builds`, `Tasks` and `Workers` all use
`DataTable`, an MUI `Table` with a search field, status buttons, a Columns chooser remembered in
local storage, sortable and filterable headers (`ColumnFilter.js`), pages, and optional expandable
rows, which the free MUI `DataGrid` doesn't have. Build rows and their task statistics are derived
in `render` by `buildStats.js`.
Task event reducers refresh the selected view before removal can hide an intermediate update in
React's batching. `Tasks` also retains the last observed row for standalone use. An open details
dialog keeps this full object (including cleared attribution) after removal, displays
`Task is no longer in the current list`, and preserves the log stream/output. Presence is checked
against full rows, not filtered rows. Do not synthesize a task status or restart log fetching on
same-ID metadata changes. Selection is cleared on dialog close/tab change; no per-task history.

**Derived values are computed in `render`, not stored in state.** `setState` inside a promise
callback does not update `this.state` synchronously under React 18's automatic batching, so
computing a metric right after `setState({tasks})` reads the previous task list. Queue time lives in
`frontend/src/metrics.js` as pure functions of `(tasks, now)`; `App` calls them from `render` with
`Date.now()` and keeps a one-second ticker only to force re-renders while a task is still waiting
(`hasWaitingTask`).

## Gotchas

- **CRA's Jest does not transform ESM in `node_modules`.** A deep MUI *file* import such as
  `@mui/material/colors/red` resolves to an untransformed ESM file and fails any test that imports
  the module; the *directory* form `@mui/material/colors` resolves to MUI's CJS build and works.
- `App.test.js` stubs `global.fetch` and `global.WebSocket`, and uses fake timers — which advance
  the clock the metrics read, so advance timers rather than calling `jest.setSystemTime` on top.
