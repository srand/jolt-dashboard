import React from 'react';

import BuildButton from './BuildButton';
import DataTable from './DataTable';
import LogButton from './LogButton';
import Attribution from './Attribution';
import PauseButton from './PauseButton';
import TaskLog from "./TaskLog"

const COLUMN_VISIBILITY_STORAGE_KEY = 'jolt-dashboard.tasks.columnVisibility.v1';

const STATUSES = ["Queued", "Assigned", "Running", "Passed", "Failed", "Cancelled"];

// Seconds between the start and the end of a task, or null.
function taskDuration(task) {
  if (!task.Started || !task.Ended) {
    return null;
  }
  return (new Date(task.Ended) - new Date(task.Started)) / 1000;
}

// Formats seconds like the Duration column.
function formatDuration(value) {
  if (value === null) {
    return "";
  }
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  // Round to one decimal place
  const seconds = Math.round((value % 60) * 10) / 10;
  if (hours === 0 && minutes === 0) {
    return seconds + "s";
  }
  if (hours === 0) {
    return minutes + "m " + seconds + "s";
  }
  return hours + "h " + minutes + "m " + seconds + "s";
}

// The texts of a task that the search field matches.
function searchTexts(task) {
  return [task.Name, task.Identity, task.Worker, task.RoutingKey, task.Build?.Origin, task.BuildId, task.Status];
}

class Tasks extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      logOpen: false,
      logTask: { "Log": "", "Name": "" },
      logTaskId: null,
    };
  }

  static getDerivedStateFromProps(props, state) {
    const currentTask = props.value.find((row) => row.id === state.logTaskId);
    // Retain the full last observed object, including cleared attribution,
    // when deletion or retention removes the selected row from the list.
    return currentTask && currentTask !== state.logTask ? { logTask: currentTask } : null;
  }

  columns() {
    return [
      { key: 'RoutingKey', label: 'Labels' },
      { key: 'Worker', label: 'Worker' },
      { key: 'Name', label: 'Name' },
      { key: 'Identity', label: 'Identity', sx: { maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' } },
      {
        key: 'Origin', label: 'Origin', value: (task) => task.Build?.Origin || '',
        render: (task) => <Attribution value={task.Build?.Origin || ''} compact />,
        sx: { maxWidth: 260 },
      },
      { key: 'Queued', label: 'Queued', sx: { whiteSpace: 'nowrap' } },
      { key: 'Assigned', label: 'Assigned', sx: { whiteSpace: 'nowrap' } },
      { key: 'Started', label: 'Started', sx: { whiteSpace: 'nowrap' } },
      { key: 'Ended', label: 'Finished', sx: { whiteSpace: 'nowrap' } },
      {
        key: 'Duration', label: 'Duration', value: (task) => taskDuration(task) ?? -1,
        text: (task) => formatDuration(taskDuration(task)), sx: { whiteSpace: 'nowrap' },
      },
      { key: 'Status', label: 'Status' },
      {
        key: 'actions', label: 'Actions', sortable: false, filterable: false,
        sx: { whiteSpace: 'nowrap', py: 0 },
        render: (task) => (
          <div style={{ display: 'flex' }}>
            <LogButton onClick={() => this.onLogClick(task)} label={`View details and log for ${task.Name}`} />
            <BuildButton
              onClick={() => this.props.onBuildClick?.(task)}
              disabled={!task.BuildId}
              label={`Show the build of ${task.Name}`}
            />
          </div>
        ),
      },
    ];
  }

  onLogClick(task) {
    this.setState({ logOpen: true, logTaskId: task.id, logTask: task });
    this.props.onLogOpen?.(task);
  }

  onLogClose() {
    this.setState({ logOpen: false });
    this.props.onLogClose?.();
  }

  render() {
    const currentTask = this.props.value.find((row) => row.id === this.state.logTaskId);
    const observedTask = this.props.selectedTask?.id === this.state.logTaskId ? this.props.selectedTask : null;
    return (
      <div className="w3-container w3-cell-row w3-margin-top">
        <TaskLog
          open={this.state.logOpen}
          onClose={() => { this.onLogClose(); }}
          task={observedTask || currentTask || this.state.logTask}
          removed={this.state.logOpen && !currentTask}
        />

        <DataTable
          label="Tasks"
          rowLabel="task"
          controlsLabel="Task controls"
          rows={this.props.value}
          columns={this.columns()}
          getId={(task) => task.id}
          defaultSort={{ key: 'Queued', order: 'desc' }}
          storageKey={COLUMN_VISIBILITY_STORAGE_KEY}
          statuses={STATUSES}
          statusOf={(task) => task.Status}
          searchLabel="Search tasks"
          searchPlaceholder="Name, identity, worker, origin or build"
          searchTexts={searchTexts}
          controls={
            <PauseButton
              color="primary"
              selected={this.props.updating}
              onPause={() => this.props.onPause?.()}
              onPlay={() => this.props.onPlay?.()}
            />
          }
        />
      </div>
    )
  }
}

export default Tasks;
