# jolt-dashboard

A real-time dashboard for [Jolt](https://github.com/srand/jolt).

## Architecture

The backend is a gRPC client of the Jolt scheduler. It subscribes to the
scheduler's `Administration.StreamEvents` RPC, which delivers a snapshot of all
queued and running tasks and all connected workers when the stream is
established, followed by incremental updates.

Because the scheduler is the source of truth and the backend resynchronizes on
every reconnect, the dashboard cannot drift out of sync. Tasks that the
dashboard still believes to be in progress but that are absent from a snapshot
were lost while the backend was disconnected and are terminated.

State is persisted in SQLite and pushed to the browser over the
`/api/v1/tasks/events` websocket.

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
