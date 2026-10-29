import './jolt.css'
import './w3.css'

import React from 'react';
import Metric from './Metric'
import { formatDuration, hasWaitingTask, queueTimeMetrics } from './metrics'
import Tasks from './Tasks';
import Workers from './Workers';
import Builds from './Builds';
import { buildRows } from './buildStats';
import * as auth from './auth';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Snackbar from '@mui/material/Snackbar';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import PropTypes from 'prop-types';
import Paper from '@mui/material/Paper';


import { ThemeProvider, createTheme } from '@mui/material/styles';
import { red, green } from '@mui/material/colors';


const theme = createTheme({
  palette: {
    primary: {
      main: red[500],

    },
    secondary: {
      main: green[500]
    },
  },
  status: {
    danger: 'orange',
  },
});

const OVERFLOW_CLOSE_CODE = 1013;

// The kinds of updates on the event stream, the lists they update and the
// fields that mark them as deleted.
const STREAMS = {
  task: { list: 'tasks', statusKey: 'Status' },
  worker: { list: 'workers', statusKey: 'TaskStatus' },
  build: { list: 'builds', statusKey: 'Status' },
};
const RECONNECT_DELAY_MS = 10000;

const TAB_BUILDS = 0;
const TAB_TASKS = 1;
const TAB_WORKERS = 2;


function TabPanel(props) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`nav-tabpanel-${index}`}
      aria-labelledby={`nav-tab-${index}`}
      {...other}
    >
      {value === index && (
        <Box p={3}>
          <Typography component="div">{children}</Typography>
        </Box>
      )}
    </div>
  );
}

TabPanel.propTypes = {
  children: PropTypes.node,
  index: PropTypes.any.isRequired,
  value: PropTypes.any.isRequired,
};

class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      menuItem: TAB_BUILDS,
      updating: true,
      tasks: [],
      workers: [],
      builds: [],
      selectedTask: null,
      // Only tasks and workers of this build are shown, if set.
      buildFilter: null,
      expandedBuilds: [],
      selectedBuildId: null,
      user: auth.currentUser(),
      // Whether users can sign in, which the backend tells.
      authConfigured: false,
      // Build to stop, waiting for confirmation.
      stopBuild: null,
      notice: null,
    };
  }

  websocketUrl(path) {
    const protocol = window.location.protocol === "https:" ? "wss://" : "ws://";
    return protocol + window.location.host + path;
  }

  connectEvents() {
    const client = new WebSocket(this.websocketUrl('/api/v1/events'));
    this.client = client;
    let initialized = false;
    let active = true;
    const validItem = (statusKey) => (item) => item && typeof item === 'object' && !Array.isArray(item) &&
      typeof item.id === 'string' && item.id.length > 0 &&
      typeof item[statusKey] === 'string' && item.type === undefined;
    const validList = (items, kind) => Array.isArray(items) && items.every(validItem(STREAMS[kind].statusKey));
    client.onmessage = (message) => {
      if (!this.mounted || this.client !== client || !active) {
        return;
      }
      let event;
      try {
        event = JSON.parse(message.data);
        if (!initialized) {
          if (event?.type !== 'snapshot' || !validList(event.tasks, 'task') ||
            !validList(event.workers, 'worker') || !validList(event.builds, 'build')) {
            throw new Error('Expected a stream snapshot');
          }
        } else if (!STREAMS[event?.type] || !validItem(STREAMS[event.type].statusKey)(event.item)) {
          throw new Error('Expected a stream update');
        }
      } catch {
        // Do not buffer or apply frames from a stream without a valid baseline.
        active = false;
        client.onmessage = null;
        client.close();
        this.scheduleReconnect(RECONNECT_DELAY_MS);
        return;
      }

      if (!initialized) {
        // Mark initialization synchronously so the next frame in this React
        // batch is an update; queue every state change in message order.
        initialized = true;
        this.setState((prevState) => {
          const nextState = { tasks: event.tasks, workers: event.workers, builds: event.builds };
          if (prevState.selectedTask) {
            nextState.selectedTask = event.tasks.find((task) =>
              task.id === prevState.selectedTask.id && task.Status !== 'Deleted') || prevState.selectedTask;
          }
          return nextState;
        });
        return;
      }
      const { list, statusKey } = STREAMS[event.type];
      const item = event.item;
      this.setState((prevState) => {
        const items = prevState[list].filter((existing) => existing.id !== item.id);
        const nextState = { [list]: items };
        if (item[statusKey] !== 'Deleted') {
          items.push(item);
          // Keep the selected full view even if a later frame removes its row
          // before React renders this batch. Deleted frames are not details.
          if (list === 'tasks' && prevState.selectedTask?.id === item.id) {
            nextState.selectedTask = item;
          }
        }
        return nextState;
      });
    };
    client.onclose = (event) => {
      active = false;
      if (this.client === client) {
        this.scheduleReconnect(event?.code === OVERFLOW_CLOSE_CODE ? 0 : RECONNECT_DELAY_MS);
      }
    };
  }

  clearReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  scheduleReconnect(delay) {
    if (!this.mounted || !this.state.updating) {
      return;
    }
    // Reconnect once, and let an overflow accelerate any ordinary reconnect
    // already waiting on its backoff.
    if (this.reconnectTimer != null && this.reconnectDelay <= delay) {
      return;
    }
    this.clearReconnect();
    this.reconnectDelay = delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.mounted && this.state.updating) {
        this.connectStreams();
      }
    }, delay);
  }

  disconnectWebsockets() {
    const client = this.client;
    if (client) {
      // Replacing/closing our own socket must not schedule another reconnect.
      client.onmessage = null;
      client.onclose = null;
      client.close();
    }
    this.client = null;
  }

  connectStreams() {
    this.clearReconnect();
    this.disconnectWebsockets();
    this.connectEvents();
  }

  componentDidMount() {
    this.mounted = true;
    this.connectStreams();

    // Only offer signing in if the dashboard is configured for it. This is not
    // a list request, so it can't race the snapshot of the event stream.
    auth.loadConfig()
      .then((config) => this.mounted && this.setState({ authConfigured: Boolean(config) }))
      .catch(() => {});

    // Back from the provider after signing in
    auth.completeSignIn()
      .then((signedIn) => signedIn && this.mounted && this.setState({ user: auth.currentUser() }))
      .catch((error) => this.mounted && this.notify('error', `Sign-in failed: ${error.message}`));

    // The queue time of a task that has not started yet grows with the wall
    // clock, so a changing task list is not enough to keep those metrics
    // current. Tick while anything is waiting; the task list drives every
    // other update on its own.
    this.ticker = setInterval(() => {
      if (hasWaitingTask(this.state.tasks)) {
        this.forceUpdate();
      }
    }, 1000);
  }

  componentWillUnmount() {
    this.mounted = false;
    clearInterval(this.ticker);
    this.clearReconnect();
    this.disconnectWebsockets();
  }

  handleMenuItemChange(event, newItem) {
    this.setState({ menuItem: newItem, selectedTask: null, selectedBuildId: null });
  };

  notify(severity, message) {
    this.setState({ notice: { severity, message } });
  }

  // Shows the build in the builds tab, expanded.
  showBuild(buildId) {
    this.setState((prevState) => ({
      menuItem: TAB_BUILDS,
      selectedTask: null,
      selectedBuildId: buildId,
      expandedBuilds: prevState.expandedBuilds.includes(buildId)
        ? prevState.expandedBuilds : [...prevState.expandedBuilds, buildId],
    }));
  }

  toggleBuild(buildId) {
    this.setState((prevState) => ({
      expandedBuilds: prevState.expandedBuilds.includes(buildId)
        ? prevState.expandedBuilds.filter((id) => id !== buildId)
        : [...prevState.expandedBuilds, buildId],
    }));
  }

  signIn() {
    auth.signIn().catch((error) => this.notify('error', error.message));
  }

  signOut() {
    auth.signOut();
    this.setState({ user: null });
  }

  async stopBuild(build) {
    this.setState({ stopBuild: null });
    const token = await auth.idToken();
    if (!token) {
      this.setState({ user: null });
      this.notify('error', 'Your sign-in has expired, sign in again to stop builds');
      return;
    }
    try {
      const response = await fetch(`/api/v1/builds/${encodeURIComponent(build.id)}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `status ${response.status}`);
      }
      this.notify('success', 'The build was stopped');
    } catch (error) {
      this.notify('error', `The build could not be stopped: ${error.message}`);
    }
  }

  onPause() {
    this.clearReconnect();
    this.disconnectWebsockets();
    this.setState({ updating: false });
  }

  onPlay() {
    this.setState({ updating: true });
    this.connectStreams();
  }

  render() {
    // Derived here, not held in state: every render then shows the queue
    // times implied by the tasks currently on screen, with no window in
    // which the two disagree.
    const now = Date.now();
    const queueTime = queueTimeMetrics(this.state.tasks, now);
    const { buildFilter } = this.state;
    const tasks = buildFilter ? this.state.tasks.filter((task) => task.BuildId === buildFilter) : this.state.tasks;
    const taskInstances = new Set(tasks.map((task) => task.id));
    const workers = buildFilter
      ? this.state.workers.filter((worker) => taskInstances.has(worker.TaskInstance))
      : this.state.workers;
    const filterChip = buildFilter && (
      <div className="w3-container w3-margin-top">
        <Chip
          color="primary"
          variant="outlined"
          label={`Build ${buildFilter.slice(0, 12)}`}
          onClick={() => this.showBuild(buildFilter)}
          onDelete={() => this.setState({ buildFilter: null })}
        />
      </div>
    );

    return (
      <div>
        <ThemeProvider theme={theme}>
          <div className="w3-border-bottom">
            <div className="w3-container w3-cell w3-margin w3-padding w3-center">
              <h1 className="jolt-box">jolt</h1>
            </div>
            <Metric name="In Queue" value={this.state.tasks.filter((task) => { return task.Status === "Queued" || task.Status === "Assigned"; }).length} />
            <Metric name="In Progress" value={this.state.tasks.filter((task) => { return task.Status === "Running"; }).length} />
            <Metric name="Completed (1h)" value={this.state.tasks.filter((task) => { return task.Status === "Passed" || task.Status === "Failed"; }).length} />
            <Metric name="Failed (1h)" value={this.state.tasks.filter((task) => { return task.Status === "Failed"; }).length} />
            <Metric name="Queue Time (1h avg)" value={formatDuration(queueTime.average)} />
            <Metric name="Queue Time (1h med)" value={formatDuration(queueTime.median)} />
            <Metric name="Queue Time (qmax)" value={formatDuration(queueTime.max)} />
          </div>
          <Paper sx={{ position: 'relative' }}>
            <Tabs
              value={this.state.menuItem}
              onChange={(event, newItem) => this.handleMenuItemChange(event, newItem)}
              indicatorColor="primary"
              textColor="primary"
              centered
            >
              <Tab label="Builds" />
              <Tab label="Tasks" />
              <Tab label="Workers" />
            </Tabs>
            <Box sx={{ position: 'absolute', right: 16, top: 0, height: '100%', display: 'flex', alignItems: 'center', gap: 1 }}>
              {this.state.user ? (
                <>
                  {/* Styled like the tabs */}
                  <Typography variant="button" color="text.secondary" aria-label="Signed in as">{this.state.user.name}</Typography>
                  <Button size="small" onClick={() => this.signOut()}>Sign out</Button>
                </>
              ) : this.state.authConfigured && (
                <Button size="small" onClick={() => this.signIn()}>Sign in</Button>
              )}
            </Box>
          </Paper>
          <TabPanel value={this.state.menuItem} index={TAB_TASKS}>
            {filterChip}
            <Tasks
              value={tasks}
              selectedTask={this.state.selectedTask}
              onLogOpen={(task) => this.setState((prevState) => ({
                selectedTask: prevState.tasks.find((row) => row.id === task.id) || task,
              }))}
              onLogClose={() => this.setState({ selectedTask: null })}
              onBuildClick={(task) => this.showBuild(task.BuildId)}
              onPause={() => this.onPause()}
              onPlay={() => this.onPlay()}
              updating={this.state.updating}
            />
          </TabPanel>
          <TabPanel value={this.state.menuItem} index={TAB_BUILDS}>
            <Builds
              builds={buildRows(this.state.builds, this.state.tasks)}
              now={now}
              user={this.state.user}
              expanded={this.state.expandedBuilds}
              filterBuildId={buildFilter}
              selectedBuildId={this.state.selectedBuildId}
              onToggle={(id) => this.toggleBuild(id)}
              onFilter={(id) => this.setState({ buildFilter: id })}
              onStop={(build) => this.setState({ stopBuild: build })}
            />
          </TabPanel>
          <TabPanel value={this.state.menuItem} index={TAB_WORKERS}>
            {filterChip}
            <Workers value={workers} />
          </TabPanel>
          <Dialog open={this.state.stopBuild !== null} onClose={() => this.setState({ stopBuild: null })}>
            <DialogTitle>Stop the build?</DialogTitle>
            <DialogContent>
              <DialogContentText>
                Build is stopped and all tasks are cancelled.
              </DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => this.setState({ stopBuild: null })}>Keep running</Button>
              <Button color="error" onClick={() => this.stopBuild(this.state.stopBuild)}>Stop build</Button>
            </DialogActions>
          </Dialog>
          <Snackbar
            open={this.state.notice !== null}
            autoHideDuration={6000}
            onClose={() => this.setState({ notice: null })}
          >
            {this.state.notice ? (
              <Alert severity={this.state.notice.severity} onClose={() => this.setState({ notice: null })}>
                {this.state.notice.message}
              </Alert>
            ) : <span />}
          </Snackbar>
        </ThemeProvider>
      </div>
    );
  }
};

export default App;
