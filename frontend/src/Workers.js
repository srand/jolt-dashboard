import React from 'react';
import { DataGrid } from '@mui/x-data-grid';
import LogButton from './LogButton';
import TaskLog from "./TaskLog"


class Workers extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            columns: [
                { field: 'Worker', headerName: 'Worker', flex: 2 },
                { field: 'Name', headerName: 'Task', flex: 4 },
                { field: 'Identity', headerName: 'Identity', flex: 2 },
                { field: 'Started', headerName: 'Started', flex: 2 },
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
                            </div>
                        );
                    }
                },
            ],
            logOpen: false,
            logTask: { "Log": "", "Name": "" },
            rows: this.workersFromTasks(props.value),
        };
    }

    workersFromTasks(tasks) {
        var map = new Map();

        for (var i = 0; i < tasks.length; i++) {
            let task = tasks[i]

            if (task["Worker"] === "") {
                continue;
            }
            if (!map.has(task["Worker"])) {
                map.set(task["Worker"], { "id": task["Worker"], "Worker": task["Worker"], "Started": "", "Log": "" });
            }
            if (task["Status"] === "Running" && map.get(task["Worker"])["Started"] < task["Started"]) {
                map.set(task["Worker"], task);
            }
        }

        return Array.from(map.values());
    }

    componentWillReceiveProps(newProps) {
        this.setState({ rows: this.workersFromTasks(newProps.value) })
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

                <DataGrid
                    autoHeight
                    so
                    initialState={{
                        sorting: {
                            sortModel: [{ field: 'Worker', sort: 'asc' }],
                        },
                    }}
                    rowHeight={40}
                    width="100%"
                    rows={this.state.rows}
                    columns={this.state.columns} />
            </div>
        )
    }
}

export default Workers;
