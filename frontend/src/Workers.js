import React from 'react';
import DataTable from './DataTable';
import LogButton from './LogButton';
import TaskLog from "./TaskLog"

const COLUMN_VISIBILITY_STORAGE_KEY = 'jolt-dashboard.workers.columnVisibility.v1';


class Workers extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            logOpen: false,
            logTask: { "id": "", "Name": "" },
        };
    }

    columns() {
        return [
            { key: 'Hostname', label: 'Worker' },
            { key: 'Labels', label: 'Labels' },
            { key: 'TaskName', label: 'Task' },
            { key: 'TaskStatus', label: 'Status' },
            { key: 'Enlisted', label: 'Enlisted', sx: { whiteSpace: 'nowrap' } },
            {
                key: 'actions', label: 'Actions', sortable: false, filterable: false, sx: { py: 0 },
                render: (worker) => (
                    <LogButton onClick={() => this.onLogClick(worker)} disabled={worker["TaskLog"] === ""} />
                ),
            },
        ];
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

                <DataTable
                    label="Workers"
                    rowLabel="worker"
                    controlsLabel="Worker controls"
                    rows={this.props.value}
                    columns={this.columns()}
                    getId={(worker) => worker.id}
                    defaultSort={{ key: 'Hostname', order: 'asc' }}
                    storageKey={COLUMN_VISIBILITY_STORAGE_KEY}
                    searchLabel="Search workers"
                    searchPlaceholder="Worker, label or task"
                    searchTexts={(worker) => [worker.Hostname, worker.Labels, worker.TaskName]}
                />
            </div>
        )
    }
}

export default Workers;
