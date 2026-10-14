import React from 'react';
import { DataGrid } from '@mui/x-data-grid';
import LogButton from './LogButton';
import TaskLog from "./TaskLog"


class Workers extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            columns: [
                { field: 'Hostname', headerName: 'Worker', flex: 2 },
                { field: 'Labels', headerName: 'Labels', flex: 2 },
                { field: 'TaskName', headerName: 'Task', flex: 4 },
                { field: 'TaskStatus', headerName: 'Status', flex: 1 },
                { field: 'Enlisted', headerName: 'Enlisted', flex: 2 },
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
                                <LogButton onClick={() => this.onLogClick(params.row)} disabled={params.row["TaskLog"] === ""} />
                            </div>
                        );
                    }
                },
            ],
            logOpen: false,
            logTask: { "id": "", "Name": "" },
        };
    }

    onLogClick(worker) {
        this.setState({ logOpen: true, logTask: { "id": worker["TaskInstance"], "Name": worker["TaskName"] } });
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

                <DataGrid
                    autoHeight
                    initialState={{
                        sorting: {
                            sortModel: [{ field: 'Hostname', sort: 'asc' }],
                        },
                    }}
                    rowHeight={40}
                    width="100%"
                    rows={this.props.value}
                    columns={this.state.columns} />
            </div>
        )
    }
}

export default Workers;
