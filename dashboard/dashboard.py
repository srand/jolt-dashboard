import dash
from dash.dependencies import Input, Output
import plotly.express as px
import plotly.graph_objects as go

from datetime import datetime, timedelta
import functools
import os
from threading import Lock, Timer
import flask
import sqlite3
import contextlib

#############################################################################

import cluster
import layout

app = dash.Dash(__name__)
app.config.suppress_callback_exceptions = True
app.layout = layout.Main()
app.title = "Jolt"



def deduplicate(func):
    @functools.wraps(func)
    def decorator(self, task):
        if os.getenv("DEDUPLICATION", "false") in ["true", "1"]:
            with self._db() as db:
                instances = self._db_select_active_task_instances_by_identity(db, task["identity"])
            if instances and task["instance"] not in instances:
                return
        func(self, task)
    return decorator



class Dashboard(object):
    def __init__(self, app):
        self.timeout = 60
        self._queue_length_hour = [0] * 60
        self._db_init()
        self.timer_callback()

    @contextlib.contextmanager
    def _db(self):
        db = sqlite3.connect("tasks.db", timeout=120, detect_types=sqlite3.PARSE_DECLTYPES)
        try:
            yield db
        finally:
            db.close()

    def _db_init(self):
        with self._db() as db:
            cur = db.cursor()
            cur.execute("DROP TABLE IF EXISTS tasks")
            cur.execute("CREATE TABLE IF NOT EXISTS tasks "
                        "(instance text PRIMARY KEY, identity text, name text, hostname text, status text, queued timestamp, started timestamp, ended timestamp)")
            db.commit()

    def _db_tojson(self, tasks):
        return [{
            "identity": task[1],
            "name": task[2],
            "worker": task[3],
            "status": task[4],
            "queued": task[5],
            "started": task[6],
            "ended": task[7],
        } for task in tasks]

    def _db_select_workers(self, db):
        cur = db.cursor()
        cur.execute("SELECT t2.instance,t2.identity,t2.name as task,t1.hostname as name,t2.status,t2.queued,t2.started,t2.ended FROM (SELECT DISTINCT t1.hostname FROM tasks t1 WHERE hostname != '') AS t1 LEFT JOIN (SELECT * FROM tasks WHERE status = 'running') AS t2 ON t2.hostname = t1.hostname")
        r = [dict((cur.description[i][0], value) \
               for i, value in enumerate(row)) for row in cur.fetchall()]
        return r

    def _db_select_task(self, db, instance):
        cur = db.cursor()
        return list(cur.execute("SELECT * FROM tasks WHERE instance = ?", (instance,)))

    def _db_select_tasks_by_status(self, db, status):
        cur = db.cursor()
        return list(cur.execute("SELECT * FROM tasks WHERE status = ?", (status,)))

    def _db_select_active_task_instances_by_identity(self, db, id):
        cur = db.cursor()
        return [n[0] for n in cur.execute("SELECT instance FROM tasks WHERE identity = ? AND status != 'failed' AND status != 'passed'", (id,)).fetchall()]

    def _db_select_tasks_active(self, db):
        cur = db.cursor()
        return list(cur.execute("SELECT * FROM tasks WHERE status != 'failed' AND status != 'passed' ORDER BY queued"))

    def _db_select_tasks_running(self, db, order="started"):
        cur = db.cursor()
        return list(cur.execute("SELECT * FROM tasks WHERE status = 'running' ORDER BY ?", (order,)))

    def _db_select_tasks_finished(self, db, since="1970-01-01T00:00:00", order="ended"):
        cur = db.cursor()
        return list(cur.execute("SELECT * FROM tasks WHERE (status = 'failed' OR status = 'passed') AND ended > ? ORDER BY ? DESC", (since, order,)))

    def _db_insert_task(self, db, task):
        cur = db.cursor()
        cur.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)", (task["instance"], task["identity"], task["name"], "", "queued", self.time(), None, None,))
        db.commit()

    def _db_update_task_set_queued(self, db, task):
        cur = db.cursor()
        cur.execute("UPDATE tasks SET queued = ?, status = ? WHERE instance = ?", (self.time(), "queued", task["instance"]))
        db.commit()

    def _db_update_task_set_started(self, db, task):
        cur = db.cursor()
        # Invalidate tasks with the same hostname, if any
        if task["role"] == "worker":
            cur.execute("UPDATE tasks SET ended = ?, status = 'passed' WHERE hostname = ? AND status = 'running'", (self.time(), task["hostname"]))
        cur.execute("UPDATE tasks SET started = ?, status = ? WHERE instance = ?", (self.time(), "running", task["instance"]))
        db.commit()
        self._db_update_task_set_hostname(db, task)

    def _db_update_task_set_hostname(self, db, task):
        if task["role"] == "client":
            return
        cur = db.cursor()
        cur.execute("UPDATE tasks SET hostname = ? WHERE instance = ?", (task["hostname"], task["instance"], ))
        db.commit()

    def _db_update_task_set_ended(self, db, task, status):
        cur = db.cursor()
        cur.execute("UPDATE tasks SET ended = ?, status = ? WHERE instance = ?", (self.time(), status, task["instance"]))
        db.commit()

    def _db_delete_old_tasks(self, age=86400):
        with self._db() as db:
            cur = db.cursor()
            cur.execute("DELETE FROM tasks WHERE MAX(IFNULL(queued, ''), IFNULL(started, ''), IFNULL(ended, '')) < ?", (self.time(age),))
            db.commit()

    def time(self, deltasecs=0):
        return (datetime.now() - timedelta(seconds=deltasecs)).strftime("%Y-%m-%d %H:%M:%S")

    def timer_callback(self):
        try:
            self._db_delete_old_tasks()
            self._queue_length_hour = self._queue_length_hour[1:] + [self.metric_queued]
        finally:
            self.timer = Timer(self.timeout, self.timer_callback)
            self.timer.start()

    @property
    def metric_queued(self):
        with self._db() as db:
            cur = db.cursor()
            return cur.execute("SELECT COUNT(*) FROM tasks WHERE status = 'queued'").fetchone()[0]

    @property
    def metric_running(self):
        with self._db() as db:
            cur = db.cursor()
            return cur.execute("SELECT COUNT(*) FROM tasks WHERE status = 'running'").fetchone()[0]

    @property
    def metric_failed(self):
        with self._db() as db:
            cur = db.cursor()
            return cur.execute("SELECT COUNT(*) FROM tasks WHERE status = 'failed' AND ended > ?", (self.time(3600),)).fetchone()[0]

    @property
    def metric_completed(self):
        with self._db() as db:
            cur = db.cursor()
            return cur.execute("SELECT COUNT(*) FROM tasks WHERE status IN ('passed', 'failed') AND ended > ?", (self.time(3600),)).fetchone()[0]

    @property
    def metric_worker_count(self):
        with self._db() as db:
            return len(self._db_select_workers(db))

    @property
    def metric_worker_load(self):
        with self._db() as db:
            return len(self._db_select_tasks_by_status(db, "running"))

    @deduplicate
    def post_queued(self, task):
        with self._db() as db:
            self._db_insert_task(db, task)
            self._db_update_task_set_queued(db, task)

    @deduplicate
    def post_started(self, task):
        with self._db() as db:
            if not self._db_select_task(db, task["instance"]):
                self._db_insert_task(db, task)
                self._db_update_task_set_queued(db, task)
            self._db_update_task_set_started(db, task)

    @deduplicate
    def post_finished(self, task):
        with self._db() as db:
            if not self._db_select_task(db, task["instance"]):
                self._db_insert_task(db, task)
                self._db_update_task_set_queued(db, task)
                self._db_update_task_set_started(db, task)
            self._db_update_task_set_ended(db, task, "passed")

    @deduplicate
    def post_failed(self, task):
        with self._db() as db:
            if not self._db_select_task(db, task["instance"]):
                self._db_insert_task(db, task)
                self._db_update_task_set_queued(db, task)
                self._db_update_task_set_started(db, task)
            self._db_update_task_set_ended(db, task, "failed")

    @property
    def tasks_live(self):
        with self._db() as db:
            return self._db_tojson(self._db_select_tasks_active(db))

    @property
    def tasks_ended(self):
        with self._db() as db:
            return self._db_tojson(self._db_select_tasks_finished(db))

    @property
    def timeline_hour(self):
        now = datetime.now()
        return {(now - timedelta(hours=1) + timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M"): 0 for i in range(0, 60)}

    @property
    def graph_queue(self):
        fig = px.area([dict(time=time, count=count) for time, count in zip(self.timeline_hour, self._queue_length_hour)], x="time", y="count", title="Task Queue Length (1h)")
        return fig

    @property
    def graph_completed(self):
        with self._db() as db:
            cur = db.cursor()
            cur.execute("SELECT strftime('%Y-%m-%d %H:%M', ended) as time, COUNT(*) as count FROM tasks WHERE ended > ? AND status = 'passed' GROUP BY strftime('%Y-%m-%d %H:%M', ended)", (self.time(3600),))
            passed = {row[0]: row[1] for row in cur.fetchall()}
            cur.execute("SELECT strftime('%Y-%m-%d %H:%M', ended) as time, COUNT(*) as count FROM tasks WHERE ended > ? AND status = 'failed' GROUP BY strftime('%Y-%m-%d %H:%M', ended)", (self.time(3600),))
            failed = {row[0]: row[1] for row in cur.fetchall()}

        pass_y = []
        fail_y = []
        time_x = []
        for time in self.timeline_hour:
            time_x.append(time)
            pass_y.append(passed.get(time, 0))
            fail_y.append(failed.get(time, 0))

        fig = go.Figure()
        fig.add_trace(go.Scatter(name="failed", x=time_x, y=fail_y, stackgroup='one', fillcolor='#f44336', mode= 'none'))
        fig.add_trace(go.Scatter(name="passed", x=time_x, y=pass_y, stackgroup='one', fillcolor='#40C040', mode='lines'))
        fig.update_traces(line_color="green", selector=dict(type='scatter'))
        fig.update_layout(
            title_text="Tasks Completed (1h)",
            xaxis_title="time",
            yaxis_title="count",
        )

        return fig

    @property
    def graph_worker(self):
        with self._db() as db:
            finished = self._db_tojson(self._db_select_tasks_finished(db, self.time(3600)))
            running = self._db_tojson(self._db_select_tasks_running(db))

        for task in running:
            task["ended"] = self.time()

        order = {"worker": sorted([worker["name"] for worker in self.workers], key=lambda item: (len(item), item))}

        fig = px.timeline(finished+running, category_orders=order, height=len(order["worker"])*30, x_start="started", x_end="ended", y="worker", color="worker", hover_name="name", range_x=(self.time(3600), self.time()))
        fig.layout.update(showlegend=False)
        return fig

    @property
    def workers(self):
        with self._db() as db:
            return self._db_select_workers(db)


dashboard = Dashboard(app)


@app.callback(
    Output('tasklist', 'data'),
    [Input('tabs-tasks', 'value')])
def tab_selected(tab):
    return dashboard.tasks_ended


@app.callback(
    [
        Output('graph_queue', 'figure'),
        Output('graph_completed', 'figure'),
        #Output('graph_worker', 'figure'),
        Output('metric_tasks_queued', 'children'),
        Output('metric_tasks_running', 'children'),
        Output('metric_tasks_failed', 'children'),
        Output('metric_tasks_completed', 'children'),
        Output('tasklist_live', 'data'),
        Output('workerlist', 'data')
    ],
    [Input('interval', 'n_intervals')])
def interval(n_intervals):
    return [
        dashboard.graph_queue,
        dashboard.graph_completed,
        #dashboard.graph_worker,
        dashboard.metric_queued,
        dashboard.metric_running,
        dashboard.metric_failed,
        dashboard.metric_completed,
        dashboard.tasks_live,
        sorted(dashboard.workers, key=lambda w: w["name"])
    ]


@app.server.route('/api/v1/tasks', methods=['POST'])
def post_task():
    data = flask.request.get_json()

    if data["event"] == "queued":
        dashboard.post_queued(data)
    elif data["event"] == "started":
        dashboard.post_started(data)
    elif data["event"] == "failed":
        dashboard.post_failed(data)
    elif data["event"] == "finished":
        dashboard.post_finished(data)
    return ""


@app.server.route('/api/v1/logs/<worker>')
async def log(worker):
    headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked'
    }

    return cluster.logs(worker), headers


if __name__ == '__main__':
    release = os.getenv("RELEASE", "true") in ["true", "1"]
    app.run_server(debug=not release , host='0.0.0.0', port=80 if release else 5000)
