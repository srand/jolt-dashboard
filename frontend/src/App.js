import './jolt.css'
import './w3.css'

import React from 'react';
import Metric from './Metric'
import { formatDuration, hasWaitingTask, queueTimeMetrics } from './metrics'
import Tasks from './Tasks';
import Workers from './Workers';
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
const RECONNECT_DELAY_MS = 10000;


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
      menuItem: 0,
      updating: true,
      tasks: [],
      workers: [],
      selectedTask: null,
    };
  }

  websocketUrl(path) {
    const protocol = window.location.protocol === "https:" ? "wss://" : "ws://";
    return protocol + window.location.host + path;
  }

  connectWebsocket(list, clientKey, statusKey) {
    const client = new WebSocket(this.websocketUrl(`/api/v1/${list}/events`));
    this[clientKey] = client;
    let initialized = false;
    let active = true;
    const validItem = (item) => item && typeof item === 'object' && !Array.isArray(item) &&
      typeof item.id === 'string' && item.id.length > 0 &&
      typeof item[statusKey] === 'string' && item.type === undefined;
    client.onmessage = (message) => {
      if (!this.mounted || this[clientKey] !== client || !active) {
        return;
      }
      let event;
      try {
        event = JSON.parse(message.data);
        if (!initialized) {
          if (event?.type !== 'snapshot' || !Array.isArray(event.items) || !event.items.every(validItem)) {
            throw new Error('Expected a stream snapshot');
          }
        } else if (!validItem(event)) {
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
          const nextState = { [list]: event.items };
          if (list === 'tasks' && prevState.selectedTask) {
            nextState.selectedTask = event.items.find((task) =>
              task.id === prevState.selectedTask.id && task.Status !== 'Deleted') || prevState.selectedTask;
          }
          return nextState;
        });
        return;
      }
      this.setState((prevState) => {
        const items = prevState[list].filter((item) => item.id !== event.id);
        const nextState = { [list]: items };
        if (event[statusKey] !== 'Deleted') {
          items.push(event);
          // Keep the selected full view even if a later frame removes its row
          // before React renders this batch. Deleted frames are not details.
          if (list === 'tasks' && prevState.selectedTask?.id === event.id) {
            nextState.selectedTask = event;
          }
        }
        return nextState;
      });
    };
    client.onclose = (event) => {
      active = false;
      if (this[clientKey] === client) {
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
    // Both streams can overflow together. Reconnect once, and let an overflow
    // accelerate any ordinary reconnect already waiting on its backoff.
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
    for (const client of [this.client, this.workerClient]) {
      if (client) {
        // Replacing/closing our own sockets must not schedule another reconnect.
        client.onmessage = null;
        client.onclose = null;
        client.close();
      }
    }
    this.client = null;
    this.workerClient = null;
  }

  connectStreams() {
    this.clearReconnect();
    this.disconnectWebsockets();
    this.connectWebsocket('tasks', 'client', 'Status');
    this.connectWebsocket('workers', 'workerClient', 'TaskStatus');
  }

  componentDidMount() {
    this.mounted = true;
    this.connectStreams();

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
    this.setState({ menuItem: newItem, selectedTask: null });
  };

  handleTaskDeleted(task) {
    fetch("/api/v1/tasks/" + task.id, { method: 'DELETE' })
      .then(() => {
        this.setState((prevState) => ({
          tasks: prevState.tasks.filter(function (task2) {
            return task2.id !== task.id
          })
        }));
      });
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
    const queueTime = queueTimeMetrics(this.state.tasks, Date.now());

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
          <Paper>
            <Tabs
              value={this.state.menuItem}
              onChange={(event, newItem) => this.handleMenuItemChange(event, newItem)}
              indicatorColor="primary"
              textColor="primary"
              centered
            >
              <Tab label="Tasks" />
              <Tab label="Workers" />
            </Tabs>
          </Paper>
          <TabPanel value={this.state.menuItem} index={0}>
            <Tasks
              value={this.state.tasks}
              selectedTask={this.state.selectedTask}
              onLogOpen={(task) => this.setState((prevState) => ({
                selectedTask: prevState.tasks.find((row) => row.id === task.id) || task,
              }))}
              onLogClose={() => this.setState({ selectedTask: null })}
              onDeleteClick={(task) => this.handleTaskDeleted(task)}
              onPause={() => this.onPause()}
              onPlay={() => this.onPlay()}
              updating={this.state.updating}
            />
          </TabPanel>
          <TabPanel value={this.state.menuItem} index={1}>
            <Workers value={this.state.workers} />
          </TabPanel>
        </ThemeProvider>
      </div>
    );
  }
};

export default App;
