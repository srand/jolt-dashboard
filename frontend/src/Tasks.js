import React from 'react';

import Box from '@mui/material/Box';
import { DataGrid } from '@mui/x-data-grid';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

import DeleteButton from './DeleteButton';
import LogButton from './LogButton';
import PauseButton from './PauseButton';
import TaskLog from "./TaskLog"


class Tasks extends React.Component {
  constructor(props) {
    super(props);
    let value = props.value;
    this.state = {
      columns: [
        { field: 'RoutingKey', headerName: 'Labels', flex: 1 },
        { field: 'Worker', headerName: 'Worker', flex: 2 },
        { field: 'Name', headerName: 'Name', flex: 4, resizeable: true},
        { field: 'Identity', headerName: 'Identity', flex: 2 },
        { field: 'Queued', headerName: 'Queued', flex: 2 },
        { field: 'Started', headerName: 'Started', flex: 2 },
        { field: 'Ended', headerName: 'Finished', flex: 2 },
        { field: 'Duration',
          headerName: 'Duration',
          flex: 1,
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
        { field: 'Status', headerName: 'Status', flex: 1 },
        {
          field: "actions",
          headerName: "Actions",
          type: "actions",
          sortable: false,
          flex: 1,
          disableClickEventBubbling: true,
          renderCell: (params) => {
            return (
              <div>
                <LogButton onClick={() => this.onLogClick(params.row)} disabled={params.row["Log"] === ""} />
                <DeleteButton onClick={() => props.onDeleteClick(params.row)} />
              </div>
            );
          }
        },
      ],
      rows: value,
      filteredRows: value,
      filters: ["Queued", "Running", "Passed", "Failed", "Cancelled"],
      logOpen: false,
      logTask: { "Log": "", "Name": "" },
    };
  }

  componentWillReceiveProps(newProps) {
    var filtered = [...newProps.value].filter((task) => { return this.state.filters.includes(task.Status); })
    this.setState({ rows: newProps.value, filteredRows: filtered })
  }

  setFilters(filters) {
    var filtered = [...this.state.rows].filter((task) => { return filters.includes(task.Status); })
    this.setState({ filters: filters, filteredRows: filtered });
  }

  onLogClick(task) {
    this.setState({ logOpen: true, logTask: task });
  }

  onLogClose() {
    this.setState({ logOpen: false });
  }

  render() {
    return (
      <div className="w3-container w3-cell-row w3-margin-top">
        <TaskLog
          open={this.state.logOpen}
          onClose={() => { this.onLogClose(); }}
          task={this.state.logTask}
        />

        <Box display="flex" alignItems="center">
          <Box flexGrow={1}></Box>
          <Box className="w3-margin-right">
            <PauseButton color="primary" selected={this.props.updating} onPause={() => { this.props.onPause(); }} onPlay={() => { this.props.onPlay(); }} />
          </Box>
          <Box>
            <ToggleButtonGroup value={this.state.filters} onChange={(ev, val) => { this.setFilters(val); }}>
              <ToggleButton color="primary" value="Queued" >Queued</ToggleButton>
              <ToggleButton color="primary" value="Running" >Running</ToggleButton>
              <ToggleButton color="primary" value="Passed" >Passed</ToggleButton>
              <ToggleButton color="primary" value="Failed" >Failed</ToggleButton>
              <ToggleButton color="primary" value="Cancelled" >Cancelled</ToggleButton>
            </ToggleButtonGroup>
          </Box>
        </Box>

        <DataGrid
          autoHeight
          className='w3-margin-top'
          columns={this.state.columns}
          initialState={{
            sorting: {
              sortModel: [{ field: 'Queued', sort: 'desc' }],
            },
          }}
          rowHeight={40}
          rows={this.state.filteredRows}
          so
        />
      </div>
    )
  }
}

export default Tasks;
