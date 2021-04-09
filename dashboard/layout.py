import dash_table
import dash_html_components as html
import dash_core_components as dcc
import dash_daq as daq


def MetricCard(label, id):
    return html.Div([
        html.Div([
            html.P(label),
            html.H2("0", id=id),
        ], className="jolt-box"),
    ], className="w3-container w3-cell w3-center w3-border-left")


def TaskList(id, columns=["worker", "name", "identity", "queued", "started", "ended", "status"]):
    return html.Div(dash_table.DataTable(
        id=id,
        columns=[{"name": i.title(), "id": i} for i in columns],
        data=[],
        filter_action="native",
        style_table={"width": "100%", "textAlign": "left"},
        style_cell={"textAlign": "center", 'textOverflow': 'ellipsis'},
        style_cell_conditional=[
            {'if': {'column_id': 'name'}, 'width': '30%', "textAlign": "left"},
            {'if': {'column_id': 'identity'}, 'width': '15%'},
            {'if': {'column_id': 'worker'}, 'width': '20%', "textAlign": "left"},
            #{'if': {'column_id': 'Region'}, 'width': '30%'},
        ],
    ), className="w3-container w3-padding")


def WorkerList(id):
    columns = ["name", "task", "identity", "started"]
    return  html.Div(dash_table.DataTable(
        id=id,
        columns=[{"name": i.title(), "id": i} for i in columns],
        data=[],
        filter_action="native",
        style_table={"width": "100%"},
        style_cell={"textAlign": "center"},
        style_cell_conditional=[
            {'if': {'column_id': 'worker'}, 'width': '20%', "textAlign": "left"},
            {'if': {'column_id': 'task'}, 'width': '40%', "textAlign": "left"},
            {'if': {'column_id': 'identity'}, 'width': '25%'},
            {'if': {'column_id': 'started'}, 'width': '15%'},
            #{'if': {'column_id': 'Region'}, 'width': '30%'},
        ],
    ), className="w3-container w3-padding")


def Tabs(tabs):
    children = []
    i = 1
    for name, content in tabs:
        children.append(
            dcc.Tab(
                children=content,
                label=name,
                value='tab-'+str(i),
                style={},
                selected_style={},
                className="jolt-tab",
                selected_className="jolt-tab--selected"))
        i += 1
    return dcc.Tabs(
        id='tabs',
        value='tab-1',
        className="w3-cell-row jolt-tabs",
        parent_className='w3-cell-row',
        content_className='w3-cell-row',
        children=children)


def SmallTabs(tabs, id):
    children = []
    i = 1
    for name, content in tabs:
        children.append(
            dcc.Tab(
                children=content,
                label=name,
                value='tab-'+str(i),
                className="w3-cell-row jolt-tab-small",
                selected_className="jolt-tab-small--selected"))
        i += 1
    return dcc.Tabs(
        id=id,
        value='tab-1',
        className="w3-cell-row jolt-tabs-small",
        parent_className='w3-cell-row',
        content_className='w3-cell-row',
        children=children)


def Main():
    return html.Div([
        html.Div([
            html.Div(html.Img(src="assets/jolt.png"),
                     className="w3-container w3-cell w3-margin w3-padding w3-center jolt-box"),
            MetricCard("In Queue", "metric_tasks_queued"),
            MetricCard("In Progress", "metric_tasks_running"),
            MetricCard("Completed (1h)", "metric_tasks_completed"),
            MetricCard("Failed (1h)", "metric_tasks_failed"),
        ], className="w3-padding w3-border-bottom"),
        html.Div(
            Tabs(
                [
                    ("Overview", [
                        html.Div([
                            daq.Gauge(id='metric_cluster_load',
                                      label="Cluster Load",
                                      value=0, max=0,
                                      scale={'start': 0, 'interval': 1, 'labelInterval': '5'}),
                        ], className="w3-container w3-padding"),
                    ]),
                    ("Tasks", SmallTabs([
                        ("Live", TaskList(id="tasklist_live", columns=["worker", "name", "identity", "queued", "started", "status"])),
                        ("Last Hour", TaskList(id="tasklist")),
                    ], id="tabs-tasks")),
                    ("Workers", WorkerList(id="workerlist"))
                ]
            )
            , className="w3-cell-row w3-white"),
    ], className="w3-light-gray")
