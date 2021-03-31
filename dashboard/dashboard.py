import dash_devices
import dash_table
from dash_devices.dependencies import Input, Output
import dash_html_components as html
import dash_core_components as dcc
from datetime import datetime
import time
import asyncio
import json
import os
from quart import request
from threading import Timer

app = dash_devices.Dash(__name__)
app.config.suppress_callback_exceptions = True

def MetricCard(label, id):
    return html.Div([
        html.Div([
            html.P(label),
            html.H2("0", id=id),
        ], className="jolt-box"),
    ], className="w3-container w3-cell w3-center w3-border-left")


def TaskList(id):
    columns = ["name", "identity", "queued", "started", "ended", "status", "worker"]
    return dash_table.DataTable(
        id=id,
        columns=[{"name": i, "id": i} for i in columns],
        data=[],
        filter_action="native",
        style_table={"width": "100%"}
    )


def WorkerList(id):
    columns = ["name", "task", "identity", "started"]
    return dash_table.DataTable(
        id=id,
        columns=[{"name": i, "id": i} for i in columns],
        data=[],
        filter_action="native",
        style_table={"width": "100%"}
    )


def Tabs(tabs):
    children = []
    i = 1
    for name, content in tabs:
        children.append(dcc.Tab(children=content, label=name, value='tab-'+str(i), style=tab_style, selected_style=tab_selected_style, className='w3-cell-row'))
        i += 1
    return dcc.Tabs(id='tabs-example', value='tab-1', className="w3-cell-row", parent_className='w3-cell-row', content_className='w3-cell-row w3-padding', children=children, style=tabs_styles)


tabs_styles = {
    'width': '100%',
    'borderTop': '1px solid #d6d6d6',
    'borderBottom': '1px solid #d6d6d6',
    'backgroundColor': '#f8f8f8',
    #'align-items': 'center',
    #'justify-content': 'center',
}

tab_style = {
    'backgroundColor': '#f6f6f6',
    #'borderTop': '1px solid #d6d6d6',
    #'borderBottom': '1px solid #d6d6d6',
    'padding': '16px',
    'width': "200px"
}

tab_selected_style = {
    'borderTop': '1px solid #d6d6d6',
    #'borderBottom': '1px solid #d6d6d6',
    'backgroundColor': '#c00000',
    'fontWeight': 'bold',
    'color': 'white',
    'padding': '16px',
    'width': "200px"
}



app.layout = html.Div([
    html.Div([
        html.Div(html.Img(src="assets/jolt.png"), className="w3-container w3-cell w3-margin w3-padding w3-center jolt-box"),
        MetricCard("In Queue", "metric_tasks_queued"),
        MetricCard("In Progress", "metric_tasks_running"),
        MetricCard("Completed (1h)", "metric_tasks_completed"),
        MetricCard("Failed (1h)", "metric_tasks_failed"),
        #MetricCard("Executed (24h)", "tasks_executed_24h"),
        #MetricCard("Failed (24h)", "tasks_failed_24h"),
        #MetricCard("Artifacts (24h)", "tasks_artifacts"),
    ], className="w3-padding w3-border-bottom"),
    html.Div(
        Tabs(
            [
                ("Tasks", TaskList(id="tasklist")),
                ("Workers", WorkerList(id="workerlist"))
            ]
        )
    , className="w3-cell-row w3-white"),
], className="w3-light-gray")


class Dashboard(object):
    def __init__(self, app):
        self.tasks = []
        self.tasks_index = {}
        self.workers = {}

        self.metric_queued = 0
        self.metric_running = 0
        self.metric_failed = 0
        self.metric_completed = 0

        self.callbacks()
        self.timeout = 60
        self.timer = Timer(self.timeout, self.prune_tasks)
        self.timer.start()

    def callbacks(self):
        pass

    def time(self):
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def find(self, task):
        dbtask = self.tasks_index.get(task["uuid"])
        if not dbtask:
            dbtask = task
            self.tasks.insert(0, dbtask)
            self.tasks_index[task["uuid"]] = dbtask
        dbtask["worker"] = task["worker"]
        return dbtask

    def update_workers(self, task):
        worker = {}
        worker["name"] = task["worker"]
        if task.get("started") and not task.get("ended"):
            worker["task"] = task["name"]
            worker["identity"] = task["identity"]
            worker["started"] = task["started"]
        else:
            worker["task"] = "<idle>"
            worker["identity"] = ""
            worker["started"] = ""
        dbworker = self.workers.get(task["worker"], {})
        dbworker.update(worker)
        self.workers[task["worker"]] = dbworker

    def post_queued(self, task):
        task = self.find(task)
        task["queued"] = self.time()
        task["status"] = "queued"
        self.metric_queued += 1
        self.update_workers(task)
        self.push()

    def post_started(self, task):
        task = self.find(task)
        task["started"] = self.time()
        task["status"] = "running"
        if task.get("queued"):
            self.metric_queued -= 1
        self.metric_running += 1
        self.update_workers(task)
        self.push()

    def post_finished(self, task):
        task = self.find(task)
        task["ended"] = self.time()
        task["status"] = "passed"
        if task.get("started"):
            self.metric_running -= 1
        elif task.get("queued"):
            self.metric_queued -= 1
        self.metric_completed += 1
        self.update_workers(task)
        self.push()

    def post_failed(self, task):
        task = self.find(task)
        task["ended"] = self.time()
        task["status"] = "failed"
        if task.get("started"):
            self.metric_running -= 1
        elif task.get("queued"):
            self.metric_queued -= 1
        self.metric_failed += 1
        self.metric_completed += 1
        self.update_workers(task)
        self.push()

    def push(self):
        self.push_timer = Timer(1, self.push_callback)
        self.push_timer.start()

    def push_callback(self):
        app.push_mods({
            'metric_tasks_queued': {'children': self.metric_queued},
            'metric_tasks_running': {'children': self.metric_running},
            'metric_tasks_failed': {'children': self.metric_failed},
            'metric_tasks_completed': {'children': self.metric_completed},
            'tasklist': {'data': self.tasks},
            'workerlist': {'data': sorted(self.workers.values(), key=lambda w: w["name"])}
        })

    def task_seen(self, task, seconds):
        last_seen = task.get("queued") or task.get("started") or task.get("ended")
        last_seen = datetime.strptime(last_seen, "%Y-%m-%d %H:%M:%S").timestamp()
        return datetime.now().timestamp() - last_seen < seconds

    def prune_tasks(self):
        alive = []
        for task in self.tasks:
            if not self.task_seen(task, 60*60): # 1h
                del self.tasks_index[task["uuid"]]
                if task["status"] == "passed":
                    self.metric_completed -= 1
                elif task["status"] == "failed":
                    self.metric_completed -= 1
                    self.metric_failed -= 1
                elif task["status"] == "running":
                    self.metric_running -= 1
                elif task["status"] == "queued":
                    self.metric_queued -= 1
            else:
                alive.append(task)
        self.tasks = alive
        self.push()
        self.timer = Timer(self.timeout, self.prune_tasks)
        self.timer.start()


dashboard = Dashboard(app)


@app.server.route('/api/v1/task/queued', methods=['POST'])
async def queued():
    data = await request.get_json()
    dashboard.post_queued(data)
    return ""

@app.server.route('/api/v1/task/started', methods=['POST'])
async def started():
    data = await request.get_json()
    dashboard.post_started(data)
    return ""

@app.server.route('/api/v1/task/finished', methods=['POST'])
async def finished():
    data = await request.get_json()
    dashboard.post_finished(data)
    return ""

@app.server.route('/api/v1/task/failed', methods=['POST'])
async def failed():
    data = await request.get_json()
    dashboard.post_failed(data)
    return ""


if __name__ == '__main__':
    release = os.getenv("RELEASE", "true") in ["true", "1"]
    app.run_server(debug=not release , host='0.0.0.0', port=80 if release else 5000)
