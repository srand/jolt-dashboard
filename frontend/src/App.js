import './jolt.css'
import './w3.css'

import React from 'react';
import Metric from './Metric'
import Tasks from './Tasks';
import Workers from './Workers';
import Tabs from '@material-ui/core/Tabs';
import Tab from '@material-ui/core/Tab';
import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import PropTypes from 'prop-types';
import Paper from '@material-ui/core/Paper';


import { ThemeProvider, createTheme } from '@mui/material/styles';
import red from '@material-ui/core/colors/red';
import green from '@material-ui/core/colors/green';


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
          <Typography>{children}</Typography>
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
      queueTimeAvg: 0,
      queueTimeMed: 0,
      queueTimeMax: 0,
    };
  }

  connectWebsocket() {
    if (window.location.protocol === "https:") {
      this.client = new WebSocket('wss://' + window.location.host + '/api/v1/tasks/events');
    } else {
      this.client = new WebSocket('ws://' + window.location.host + '/api/v1/tasks/events');
    }
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

  fetchAndConnect() {
    this.fetchTasks();
    this.connectWebsocket();
  }

  componentDidMount() {
    this.fetchAndConnect();
  }

  fetchTasks() {
    fetch("/api/v1/tasks")
      .then((response) => response.json())
      .then((json) => {
        this.setState({ tasks: json });
        this.updateMetrics();

      })
      .catch((reason) => {
        this.updateMetrics();
      });
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

  formatTime(duration) {
    // Convert seconds to human readable format
    var hours = Math.floor(duration / 3600);
    var minutes = Math.floor((duration % 3600) / 60);
    var seconds = duration % 60;

    // Round to integer
    seconds = Math.round(seconds);

    if (hours === 0 && minutes === 0) {
      return seconds + "s";
    }
    if (hours === 0) {
      return minutes + "m " + seconds + "s";
    }
    return hours + "h " + minutes + "m " + seconds + "s";
  }

  updateMetrics() {
    var tasks = this.state.tasks.filter((task) => {
      return task.Status === "Running" || task.Status === "Queued" || task.Status === "Passed" || task.Status === "Failed";
    });

    if (tasks.length === 0) {
      this.setState({
        queueTimeAvg: this.formatTime(0),
        queueTimeMed: this.formatTime(0),
        queueTimeMax: this.formatTime(0),
      });
      setTimeout(this.updateMetrics.bind(this), 1000);
      return;
    }

    tasks = [...tasks].map((task) => {
      var queued = new Date(task["Queued"]);
      var started = task["Started"] === "" ? new Date() : new Date(task["Started"]);
      var qtime = started - queued;
      var seconds = qtime / 1000;
      if (seconds < 0) {
        seconds = 0;
      }
      return {
        "id": task.id,
        "qtime": seconds,
        "status": task.Status,
      };
    })

    var queued = tasks.filter((task) => { return task.status === "Queued"; });
    var qtimes = tasks.map((task) => { return task.qtime; }).sort((a, b) => a - b);
    var qtimes_queued = queued.map((task) => { return task.qtime; }).sort((a, b) => a - b);

    console.log("tasks: ", tasks);
    console.log("qtimes: ", qtimes);
    console.log("qtimes_queued: ", qtimes_queued);

    // Calculate average
    var sum = qtimes.reduce((a, b) => a + b, 0);
    var avg = sum / tasks.length;

    // Calculate median
    var mid = Math.floor(qtimes.length / 2);
    var median = qtimes.length % 2 !== 0 ? qtimes[mid] : (qtimes[mid - 1] + qtimes[mid]) / 2;

    this.setState({
      queueTimeAvg: this.formatTime(avg),
      queueTimeMed: this.formatTime(median),
      queueTimeMax: this.formatTime(qtimes_queued.length > 0 ? qtimes_queued[qtimes_queued.length - 1] : 0),

    });

    setTimeout(this.updateMetrics.bind(this), 10000);
  }

  render() {
    return (
      <div>
        <ThemeProvider theme={theme}>
          <div className="w3-border-bottom">
            <div className="w3-container w3-cell w3-margin w3-padding w3-center">
              <h1 className="jolt-box">jolt</h1>
            </div>
            <Metric name="In Queue" value={this.state.tasks.filter((task) => { return task.Status === "Queued"; }).length} />
            <Metric name="In Progress" value={this.state.tasks.filter((task) => { return task.Status === "Running"; }).length} />
            <Metric name="Completed (1h)" value={this.state.tasks.filter((task) => { return task.Status === "Passed" || task.Status === "Failed"; }).length} />
            <Metric name="Failed (1h)" value={this.state.tasks.filter((task) => { return task.Status === "Failed"; }).length} />
            <Metric name="Queue Time (1h avg)" value={this.state.queueTimeAvg} />
            <Metric name="Queue Time (1h med)" value={this.state.queueTimeMed} />
            <Metric name="Queue Time (qmax)" value={this.state.queueTimeMax} />
          </div>
          <Paper>
            <Tabs
              value={this.state.menuItem}
              onChange={(event, newItem) => this.handleMenuItemChange(event, newItem)}
              indicatorColor="secondary"
              textColor="secondary"
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
            <Workers value={this.state.tasks} />
          </TabPanel>
        </ThemeProvider>
      </div>
    );
  }
};

export default App;
