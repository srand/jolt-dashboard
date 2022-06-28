import React from 'react';
import { DataGrid } from '@mui/x-data-grid';
import LogButton from './LogButton';


class Workers extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            columns: [
                { field: 'Worker', headerName: 'Worker', flex: 1 },
                { field: 'Name', headerName: 'Task', flex: 1 },
                { field: 'Identity', headerName: 'Identity', flex: 1 },
                { field: 'Started', headerName: 'Started', flex: 1 },
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
                                <LogButton index={params.row.id} disabled />
                            </div>
                        );
                    }
                },
            ],
            rows: this.workersFromTasks(props.value),
        };
    }

    workersFromTasks(tasks) {
        var map = new Map();

        for (var i = 0; i < tasks.length; i++) {
            let task = tasks[i]

            if (task["Worker"] == "") {
                continue;
            }
            if (!map.has(task["Worker"])) {
                map.set(task["Worker"], { "id": task["Worker"], "Worker": task["Worker"], "Started": "" });
            }
            if (task["Status"] == "Running" && map.get(task["Worker"])["Started"] < task["Started"]) {
                map.set(task["Worker"], task);
            }
        }

        return Array.from(map.values());
    }

    componentWillReceiveProps(newProps) {
        this.setState({ rows: this.workersFromTasks(newProps.value) })
    }

    render() {
        return (
            <div className="w3-container w3-cell-row w3-margin-top">
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
