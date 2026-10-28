import React from 'react';

import {
  DataGrid,
  GridColumnMenuContainer,
  GridFilterMenuItem,
  HideGridColMenuItem,
  SortGridMenuItems,
} from '@mui/x-data-grid';

import DeleteButton from './DeleteButton';
import LogButton from './LogButton';
import Attribution from './Attribution';
import TaskLog from "./TaskLog"
import TasksToolbar from './TasksToolbar';

const COLUMN_VISIBILITY_STORAGE_KEY = 'jolt-dashboard.tasks.columnVisibility.v1';

function loadColumnVisibility(columns) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(COLUMN_VISIBILITY_STORAGE_KEY));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
      return {};
    }
    // Ignore removed columns and invalid values; new columns remain visible by default.
    return Object.fromEntries(columns
      .filter(({ field }) => Object.prototype.hasOwnProperty.call(saved, field) && typeof saved[field] === 'boolean')
      .map(({ field }) => [field, saved[field]]));
  } catch {
    // Corrupt or unavailable storage must not prevent the task list from loading.
    return {};
  }
}

// Keep column-specific actions here; the full chooser belongs in the toolbar.
const TaskColumnMenu = React.forwardRef(function TaskColumnMenu(props, ref) {
  const { hideMenu, currentColumn } = props;
  return (
    <GridColumnMenuContainer {...props} ref={ref}>
      <SortGridMenuItems onClick={hideMenu} column={currentColumn} />
      <GridFilterMenuItem onClick={hideMenu} column={currentColumn} />
      <HideGridColMenuItem onClick={hideMenu} column={currentColumn} />
    </GridColumnMenuContainer>
  );
});

class Tasks extends React.Component {
  constructor(props) {
    super(props);
    this.toolbarContainerRef = React.createRef();
    this.getToolbarContainer = () => this.toolbarContainerRef.current;
    this.state = {
      columns: [
        { field: 'RoutingKey', headerName: 'Labels', flex: 1 },
        { field: 'Worker', headerName: 'Worker', flex: 2 },
        { field: 'Name', headerName: 'Name', flex: 4, resizeable: true },
        { field: 'Identity', headerName: 'Identity', flex: 2 },
        {
          field: 'Origin',
          headerName: 'Origin',
          flex: 1,
          valueGetter: (params) => params.row.Build?.Origin || '',
          renderCell: (params) => <Attribution value={params.value} compact />,
        },
        {
          field: 'Username',
          headerName: 'Username',
          flex: 1,
          valueGetter: (params) => params.row.Build?.Username || '',
          renderCell: (params) => <Attribution value={params.value} compact textOnly />,
        },
        { field: 'Queued', headerName: 'Queued', width: 180 },
        { field: 'Assigned', headerName: 'Assigned', width: 180 },
        { field: 'Started', headerName: 'Started', width: 180 },
        { field: 'Ended', headerName: 'Finished', width: 180 },
        {
          field: 'Duration',
          headerName: 'Duration',
          width: 100,
          align: 'center',
          valueGetter: (params) => {
            // Calculate duration from Started and Ended timestamps
            if (params.row["Started"] === "" || params.row["Ended"] === "") {
              return null;
            }
            var started = new Date(params.row["Started"]);
            var ended = new Date(params.row["Ended"]);
            var duration = ended - started;
            var seconds = duration / 1000;
            return seconds;
          },
          renderCell: (params) => {
            if (params.value === null) {
              return "";
            }

            // Convert seconds to human readable format
            var hours = Math.floor(params.value / 3600);
            var minutes = Math.floor((params.value % 3600) / 60);
            var seconds = params.value % 60;

            // Round to one decimal place
            seconds = Math.round(seconds * 10) / 10;

            if (hours === 0 && minutes === 0) {
              return seconds + "s";
            }
            if (hours === 0) {
              return minutes + "m " + seconds + "s";
            }
            return hours + "h " + minutes + "m " + seconds + "s";
          },
        },
        { field: 'Status', headerName: 'Status', width: 100 },
        {
          field: "actions",
          headerName: "Actions",
          type: "actions",
          sortable: false,
          // Two 40px buttons plus the grid's horizontal cell padding.
          width: 100,
          minWidth: 100,
          disableClickEventBubbling: true,
          renderCell: (params) => {
            return (
              <div>
                <LogButton onClick={() => this.onLogClick(params.row)} label={`View details and log for ${params.row.Name}`} />
                <DeleteButton onClick={() => props.onDeleteClick(params.row)} />
              </div>
            );
          }
        },
      ],
      filters: ["Queued", "Assigned", "Running", "Passed", "Failed", "Cancelled"],
      logOpen: false,
      logTask: { "Log": "", "Name": "" },
      logTaskId: null,
    };
    this.initialColumnVisibilityModel = loadColumnVisibility(this.state.columns);
  }

  static getDerivedStateFromProps(props, state) {
    const currentTask = props.value.find((row) => row.id === state.logTaskId);
    // Retain the full last observed object, including cleared attribution,
    // when deletion or retention removes the selected row from the list.
    return currentTask && currentTask !== state.logTask ? { logTask: currentTask } : null;
  }

  setFilters(filters) {
    this.setState({ filters: filters });
  }

  saveColumnVisibility(model) {
    try {
      window.localStorage.setItem(COLUMN_VISIBILITY_STORAGE_KEY, JSON.stringify(model));
    } catch {
      // The grid still keeps the selection for this session if storage is blocked or full.
    }
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
    const filteredRows = this.props.value.filter((task) => { return this.state.filters.includes(task.Status); });
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

        <div ref={this.toolbarContainerRef} />

        <DataGrid
          autoHeight
          className='w3-margin-top'
          columns={this.state.columns}
          // This small grid must keep Actions mounted across flex-width resizes.
          columnBuffer={this.state.columns.length}
          onColumnVisibilityModelChange={(model) => this.saveColumnVisibility(model)}
          components={{ Toolbar: TasksToolbar, ColumnMenu: TaskColumnMenu }}
          componentsProps={{
            toolbar: {
              container: this.getToolbarContainer,
              filters: this.state.filters,
              updating: this.props.updating,
              onFiltersChange: (filters) => this.setFilters(filters),
              onPause: () => this.props.onPause(),
              onPlay: () => this.props.onPlay(),
            },
          }}
          initialState={{
            columns: {
              columnVisibilityModel: this.initialColumnVisibilityModel,
            },
            sorting: {
              sortModel: [{ field: 'Queued', sort: 'desc' }],
            },
          }}
          rowHeight={40}
          rows={filteredRows}
          so
        />
      </div>
    )
  }
}

export default Tasks;
