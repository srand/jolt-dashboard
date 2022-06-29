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
      tasks: [],
    };
  }

  connectWebsocket() {
    var client
    if (window.location.protocol === "https:") {
      client = new WebSocket('wss://' + window.location.host + '/api/v1/tasks/events');
    } else {
      client = new WebSocket('ws://' + window.location.host + '/api/v1/tasks/events');
    }
    client.onmessage = (message) => {
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
    client.onclose = () => {
      setTimeout(this.fetchAndConnect.bind(this), 10000);
    };
  }

  fetchAndConnect() {
    this.connectWebsocket();
    this.fetchTasks();
  }

  componentDidMount() {
    this.fetchAndConnect();
  }

  fetchTasks() {
    fetch("/api/v1/tasks")
      .then((response) => response.json())
      .then((json) => {
        this.setState({ tasks: json });
      })
      .catch((reason) => {
        console.log(reason);
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
