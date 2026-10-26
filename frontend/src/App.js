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
    };
  }

  websocketUrl(path) {
    const protocol = window.location.protocol === "https:" ? "wss://" : "ws://";
    return protocol + window.location.host + path;
  }

  connectWebsocket() {
    this.client = new WebSocket(this.websocketUrl('/api/v1/tasks/events'));
    this.client.onmessage = (message) => {
      if (!this.state.updating) {
        this.client.close();
        return
      }

      var task = JSON.parse(message.data);
      this.setState(function (prevState, props) {
        let tasks = prevState.tasks.filter(function (task2) {
          return task2.id !== task.id;
        })
        if (task.Status !== "Deleted") {
          tasks.push(task);
        }
        return { tasks: tasks };
      });
    };
    this.client.onclose = () => {
      if (this.state.updating) {
        setTimeout(this.fetchAndConnect.bind(this), 10000);
      }
    };
  }

  connectWorkerWebsocket() {
    // Reconnects are driven by the task socket, so drop any previous one.
    if (this.workerClient) {
      this.workerClient.close();
    }

    this.workerClient = new WebSocket(this.websocketUrl('/api/v1/workers/events'));
    this.workerClient.onmessage = (message) => {
      if (!this.state.updating) {
        this.workerClient.close();
        return
      }

      var worker = JSON.parse(message.data);
      this.setState(function (prevState, props) {
        let workers = prevState.workers.filter(function (worker2) {
          return worker2.id !== worker.id;
        })
        if (worker.TaskStatus !== "Deleted") {
          workers.push(worker);
        }
        return { workers: workers };
      });
    };
  }

  fetchAndConnect() {
    this.fetchTasks();
    this.fetchWorkers();
    this.connectWebsocket();
    this.connectWorkerWebsocket();
  }

  componentDidMount() {
    this.fetchAndConnect();

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
    clearInterval(this.ticker);
  }

  fetchWorkers() {
    fetch("/api/v1/workers")
      .then((response) => response.json())
      .then((json) => {
        this.setState({ workers: json });
      })
      .catch((reason) => { });
  }

  fetchTasks() {
    fetch("/api/v1/tasks")
      .then((response) => response.json())
      .then((json) => {
        this.setState({ tasks: json });
      })
      .catch((reason) => { });
  }

  handleMenuItemChange(event, newItem) {
    this.setState({ menuItem: newItem });
  };

  handleTaskDeleted(task) {
    fetch("/api/v1/tasks/" + task.id, { method: 'DELETE' })
      .then(() => {
        this.setState({
          tasks: this.state.tasks.filter(function (task2) {
            return task2.id !== task.id
          })
        });
      });
  }

  onPause() {
    this.setState({ updating: false });
  }

  onPlay() {
    this.setState({ updating: true });
    this.fetchAndConnect();
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
