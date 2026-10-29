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

## Builds

The Builds tab lists the builds of the scheduler, also those whose tasks are gone
or not yet scheduled, and those that only retained tasks still refer to. Each row
expands, on a click anywhere in it, to the statistics of the build's tasks, its
owners and all its configuration parameters.

- **Owners** are the authenticated clients that submitted the build, recorded by
  the scheduler from their tokens. Identical submissions share a build, so a build
  can have several owners. The scheduler doesn't record owners without
  authentication.
- **Parameters** are the client's `[params]` section, shown as submitted. They are
  supplied by the client and not verified. Anyone who can open the dashboard sees
  them, like every reader of the scheduler, so never put secrets in them.
- **Origin** comes from the `origin` parameter. It is shown in the task list and
  task details, and is a link if it is an absolute HTTP(S) URL:

  ```sh
  jolt -c params.origin="$BUILD_URL" build --network my-task
  ```

The filter button of a build limits the task and worker views to the build, and
a chip above them clears the filter. The build button of a task opens its build.

Signed-in users can stop builds. The dashboard forwards the user's ID token to the
scheduler, which allows owners of the build and administrators (the `admin`
permission) to cancel it. See `JOLT_AUTH_ISSUER` below.

### Event stream

The frontend follows the websocket `/api/v1/events`. Its first frame is a snapshot
of everything, `{"type":"snapshot","tasks":[...],"workers":[...],"builds":[...]}`,
taken atomically, followed by updates `{"type":"task"|"worker"|"build","item":{...}}`
in order for each kind. Items with the status `Deleted` (`TaskStatus` for workers)
are removed. If the dashboard can't keep up with the scheduler, it closes the
stream with code 1013 and the frontend reconnects for a new snapshot. The older
per-list streams `/api/v1/tasks/events` and `/api/v1/workers/events` and the REST
lists remain for other clients.

A task carries its build:

```json
{
  "id": "task-instance-uuid",
  "BuildId": "scheduler-build-id",
  "Build": {
    "Id": "scheduler-build-id",
    "Status": "BUILD_ACCEPTED",
    "Scheduled": "2026-10-26 12:00:00.123",
    "Origin": "https://ci.example.com/build/123",
    "Parameters": [{ "Key": "config.origin", "Value": "https://ci.example.com/build/123" }],
    "Owners": ["alice"],
    "Registered": true
  }
}
```

`Build` is `null` when no metadata is known, including with older schedulers.
Build status uses the protocol enum name and is independent of `Registered`:
snapshots only list registered builds, and a build that is no longer registered
keeps its metadata while retained tasks refer to it. Tasks are retained 48 hours
after queueing or one hour after ending; builds that are unregistered and have no
tasks are then removed.

The task list shows a compact Origin column with the full value on hover. Column
choices from the Columns button are remembered in the browser's local storage. An
open details dialog keeps the task's last observed state if its row is removed,
and shows `Task is no longer in the current list`.

## Configuration

| Environment variable | Description | Default |
| --- | --- | --- |
| `JOLT_SCHEDULER_URI` | gRPC URI of the scheduler, `tls://` for TLS | `tcp://jolt-scheduler:9090` |
| `JOLT_SCHEDULER_TOKEN` | Token that authenticates the dashboard with the scheduler, with the `read` permission | |
| `JOLT_CA_CERT` | PEM file with the certificates of the authorities that the scheduler's certificate is verified with, in addition to those of the system | |
| `JOLT_ALLOW_INSECURE_TOKEN` | Set to `true` to send the token without TLS | `false` |
| `PORT` | Port to serve the web application on | `8080` |
| `JOLT_AUTH_ISSUER` | OpenID Connect provider that users sign in with to stop builds, the same one that the scheduler accepts tokens from. The Sign in button is hidden if unset | |
| `JOLT_AUTH_CLIENT_ID` | Client that users sign in with; the scheduler must accept tokens issued to it (its `auth.oidc.audience`) | `jolt` |

The token is only sent over TLS unless `JOLT_ALLOW_INSECURE_TOKEN` allows otherwise. The
dashboard itself doesn't require users to sign in, so anyone who can reach it sees what the
token can read from the scheduler.

Users sign in in the browser with the authorization code flow and PKCE. The client must be
public, with the standard (browser) flow enabled, the dashboard's URL as a redirect URI and its
origin as a web origin, for example in Keycloak `https://dashboard.example.com/*` and
`https://dashboard.example.com`. The dashboard must be served over HTTPS, or from `localhost`.
Tokens are kept in the browser session and refreshed with the refresh token while it lasts.

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
