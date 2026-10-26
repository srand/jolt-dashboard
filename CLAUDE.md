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

Configuration is two environment variables: `JOLT_SCHEDULER_URI` (default
`tcp://jolt-scheduler:9090`) and `PORT` (default `8080`).

The gRPC stubs in `backend/protocol` are vendored; regenerate with `backend/protocol/generate.sh`.

## Architecture

State flows one way, and nothing in the dashboard is authoritative:

```
scheduler --gRPC StreamEvents--> scheduler.Client --> model.TaskService/WorkerService --> SQLite
                                                              |
                                                       model.Broadcast
                                                              |
                                  /api/v1/{tasks,workers}/events websocket --> App.state --> render
```

- **The scheduler is the source of truth.** Every reconnect delivers a full snapshot, which is
  reconciled against the database; anything the dashboard believed was in progress but that is
  absent from the snapshot was lost while disconnected and is terminated. This is why the dashboard
  cannot drift, and why reconciliation logic belongs in `scheduler/client.go`, not in the API layer.
- **Tasks and workers have separate `Broadcast` instances** (wired in `main.go`) so the task
  websocket only ever carries tasks. `Broadcast.Send` drops events on a full client channel rather
  than blocking — a slow browser must never stall the scheduler stream.
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

Class components throughout, no hooks. `App` owns all state (`tasks`, `workers`, `updating`) and
passes it down; `Tasks`/`Workers` are presentational wrappers around MUI's `DataGrid`.

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
