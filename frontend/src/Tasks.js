import React from 'react';

import Box from '@mui/material/Box';
import { DataGrid } from '@mui/x-data-grid';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

import DeleteButton from './DeleteButton';
import LogButton from './LogButton';
import TaskLog from "./TaskLog"


class Tasks extends React.Component {
  constructor(props) {
    super(props);
    let value = props.value;
    this.state = {
      columns: [
        { field: 'RoutingKey', headerName: 'Labels', flex: 1 },
        { field: 'Worker', headerName: 'Worker', flex: 1 },
        { field: 'Name', headerName: 'Name', flex: 1 },
        { field: 'Identity', headerName: 'Identity', flex: 1 },
        { field: 'Queued', headerName: 'Queued', flex: 1 },
        { field: 'Started', headerName: 'Started', flex: 1 },
        { field: 'Ended', headerName: 'Finished', flex: 1 },
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
      filters: ["Queued", "Running", "Passed", "Failed"],
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
          <Box>
            <ToggleButtonGroup value={this.state.filters} onChange={(ev, val) => { this.setFilters(val); }}>
              <ToggleButton color="primary" value="Queued" >Queued</ToggleButton>
              <ToggleButton color="primary" value="Running" >Running</ToggleButton>
              <ToggleButton color="primary" value="Passed" >Passed</ToggleButton>
              <ToggleButton color="primary" value="Failed" >Failed</ToggleButton>
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
