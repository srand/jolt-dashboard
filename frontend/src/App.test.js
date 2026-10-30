import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

import App from './App';

global.TextDecoder = global.TextDecoder || NodeTextDecoder;
global.TextEncoder = global.TextEncoder || NodeTextEncoder;

// Keep App, Tasks and TaskLog real; jsdom needs every grid cell rendered.
jest.mock('@mui/x-data-grid', () => {
    const React = require('react');
    const grid = jest.requireActual('@mui/x-data-grid');
    return { ...grid, DataGrid: (props) => <grid.DataGrid {...props} disableVirtualization /> };
});

// The backend serialises timestamps as "2006-01-02 15:04:05" in local time,
// which is what App parses with new Date(...), so build fixtures the same way.
function stamp(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const NOW = new Date('2026-10-15T12:00:00').getTime();

function task(id, status, queuedMsAgo, startedMsAgo) {
    return {
        id,
        Status: status,
        Name: id,
        RoutingKey: '',
        Worker: '',
        Identity: '',
        Queued: stamp(NOW - queuedMsAgo),
        Assigned: '',
        Started: startedMsAgo === null ? '' : stamp(NOW - startedMsAgo),
        Ended: '',
    };
}

// A WebSocket stand-in that records every instance so a test can push a task
// event the way the backend would.
class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.onmessage = null;
        this.onclose = null;
        FakeWebSocket.instances.push(this);
    }

    close = jest.fn();
}

function send(socket, value) {
    socket.onmessage({ data: JSON.stringify(value) });
}

function snapshot(tasks = TASKS, workers = [], offset = 0) {
    act(() => {
        send(FakeWebSocket.instances[offset], { type: 'snapshot', items: tasks });
        send(FakeWebSocket.instances[offset + 1], { type: 'snapshot', items: workers });
    });
}

function metric(name) {
    return screen.getByText(name).parentElement.querySelector('h2').textContent;
}

beforeEach(() => {
    FakeWebSocket.instances = [];
    global.WebSocket = FakeWebSocket;
    global.fetch = jest.fn(() => Promise.resolve({ json: () => Promise.resolve([]) }));
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
});

afterEach(() => {
    jest.useRealTimers();
    delete global.fetch;
    delete global.WebSocket;
    jest.clearAllMocks();
});

// Queued 120s ago, started 110s ago -> 10s in the queue.
// Queued 30s ago, still queued -> 30s in the queue and counting.
const TASKS = [
    task('passed-1', 'Passed', 120000, 110000),
    task('queued-1', 'Queued', 30000, null),
];

test('queue time metrics are right as soon as the first task snapshot arrives', () => {
    render(<App />);
    expect(metric('In Queue')).toBe('0');
    snapshot();

    // The task rows are already on screen at this point, so the queue times
    // derived from them must be too.
    expect(metric('Queue Time (1h avg)')).toBe('20s');
    expect(metric('Queue Time (1h med)')).toBe('20s');
    expect(metric('Queue Time (qmax)')).toBe('30s');
    expect(fetch).not.toHaveBeenCalled();
});

test('a task arriving over the websocket updates queue time without waiting for a poll', () => {
    render(<App />);
    snapshot();

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe('ws://localhost/api/v1/tasks/events');

    // A task that has been queued for ten minutes shows up.
    act(() => {
        send(socket, task('queued-2', 'Queued', 600000, null));
    });

    expect(metric('In Queue')).toBe('2');
    expect(metric('Queue Time (qmax)')).toBe('10m 0s');
    expect(metric('Queue Time (1h avg)')).toBe('3m 33s');
});

test('websocket task views replace nested build attribution in App state', () => {
    const initial = { ...task('attributed-task', 'Queued', 30000, null), BuildId: 'build', Build: null, Log: '' };
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([initial]);

    const socket = FakeWebSocket.instances[0];
    const build = {
        Id: 'build', Status: 'BUILD_ACCEPTED', Scheduled: stamp(NOW),
        Origin: 'https://ci.example.com/build/123', Username: 'builder@example.com', Registered: true,
    };
    for (const metadata of [build, { ...build, Origin: '', Username: '', Registered: false }, null]) {
        const update = { ...initial, Build: metadata };
        act(() => {
            send(socket, update);
        });
        expect(app.current.state.tasks).toEqual([update]);
        expect(metric('In Queue')).toBe('1');
    }

    act(() => {
        send(socket, { ...initial, Status: 'Deleted' });
    });
    expect(app.current.state.tasks).toEqual([]);
    expect(metric('In Queue')).toBe('0');
    expect(fetch).not.toHaveBeenCalled();
});

describe.each(['Deleted event', 'reconnect empty snapshot'])('open task removed by %s', (removal) => {
    test.each([
        ['updated attribution', { Origin: 'latest origin', Username: 'latest user' }],
        ['null build', null],
        ['empty attribution', { Origin: '', Username: '' }],
    ])('retains the latest full update in the same React batch: %s', async (name, build) => {
        const reader = { read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('retained log output\n') })
            .mockResolvedValue({ done: true }) };
        global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, body: { getReader: () => reader } }));
        const initial = {
            ...task('selected-task', 'Running', 30000, 20000), Name: 'Opening Build',
            Identity: 'opening identity', Ended: stamp(NOW - 10000), Log: 'opening log',
            Build: { Origin: 'opening origin', Username: 'opening user' },
        };
        const latest = {
            ...initial, Name: 'Latest Build', Identity: '', Status: 'Failed', Log: '', Build: build,
            Started: build?.Origin ? stamp(NOW - 5000) : '', Ended: build?.Origin ? stamp(NOW) : '',
        };
        const app = React.createRef();
        render(<App ref={app} />);
        snapshot([initial]);
        userEvent.click(screen.getByRole('button', { name: 'View details and log for Opening Build' }));
        await screen.findByText('retained log output');
        const dialog = screen.getByRole('dialog', { name: 'Opening Build opening identity' });
        expect(within(dialog).getByText('retained log output')).toBeInTheDocument();
        const signal = fetch.mock.calls[0][1].signal;
        const socket = FakeWebSocket.instances[0];

        // Do not render the update separately: Tasks only sees the final empty list.
        act(() => {
            send(socket, { ...latest, Build: { Origin: 'intermediate origin', Username: 'intermediate user' } });
            send(socket, latest);
            if (removal === 'Deleted event') {
                send(socket, { ...initial, Status: 'Deleted' });
            } else {
                socket.onclose({ code: 1013 });
                jest.advanceTimersByTime(0);
                send(FakeWebSocket.instances[2], { type: 'snapshot', items: [] });
                send(FakeWebSocket.instances[3], { type: 'snapshot', items: [] });
            }
        });

        expect(app.current.state.tasks).toEqual([]);
        expect(app.current.state.selectedTask).toEqual(latest);
        expect(within(dialog).getByText('Failed')).toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'Latest Build' })).toBe(dialog);
        expect(within(dialog).queryByText('opening identity')).not.toBeInTheDocument();
        expect(within(dialog).queryByText(initial.Started)).not.toBeInTheDocument();
        expect(within(dialog).queryByText(initial.Ended)).not.toBeInTheDocument();
        expect(within(dialog).getByText(latest.Started || 'Started')).toBeInTheDocument();
        expect(within(dialog).getByText(latest.Ended || 'Finished')).toBeInTheDocument();
        const attribution = within(dialog).getByRole('region', { name: 'Build attribution' });
        expect(attribution.textContent).toBe(`${build?.Origin || ''}Origin${build?.Username || ''}Username`);
        expect(within(dialog).queryByText('opening origin')).not.toBeInTheDocument();
        expect(within(dialog).queryByText('opening user')).not.toBeInTheDocument();
        expect(within(dialog).queryByText('intermediate origin')).not.toBeInTheDocument();
        expect(within(dialog).queryByText('Deleted')).not.toBeInTheDocument();
        expect(within(dialog).getByRole('status')).toHaveTextContent('Task is no longer in the current list');
        expect(within(dialog).getByText('retained log output')).toBeInTheDocument();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(signal.aborted).toBe(false);
    });
});

test('a reconnect snapshot refreshes open details before deletion in the same React batch', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404 }));
    const initial = { ...TASKS[0], Name: 'Build', Build: { Origin: 'opening origin', Username: 'alice' } };
    const latest = { ...initial, Status: 'Failed', Build: { Origin: 'snapshot origin', Username: 'bob' } };
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([initial]);
    userEvent.click(screen.getByRole('button', { name: 'View details and log for Build' }));
    await screen.findByText('No log output.');
    const dialog = screen.getByRole('dialog', { name: 'Build' });
    act(() => {
        FakeWebSocket.instances[0].onclose({ code: 1013 });
        jest.advanceTimersByTime(0);
        send(FakeWebSocket.instances[2], { type: 'snapshot', items: [latest] });
        send(FakeWebSocket.instances[2], { id: initial.id, Status: 'Deleted' });
        send(FakeWebSocket.instances[3], { type: 'snapshot', items: [] });
    });
    expect(app.current.state.tasks).toEqual([]);
    expect(within(dialog).getByText('Failed')).toBeInTheDocument();
    expect(within(dialog).getByText('snapshot origin')).toBeInTheDocument();
    expect(within(dialog).getByText('bob')).toBeInTheDocument();
    expect(within(dialog).getByRole('status')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
});

test('REST DELETE preserves selected details and unrelated updates in the same React batch', async () => {
    let finishDelete;
    global.fetch = jest.fn((url, options) => options.method === 'DELETE'
        ? new Promise((resolve) => { finishDelete = resolve; })
        : Promise.resolve({ ok: false, status: 404 }));
    const initial = { ...TASKS[0], Name: 'Build', Build: { Origin: 'opening origin', Username: 'alice' } };
    const latest = { ...initial, Status: 'Failed', Build: null };
    const other = { ...TASKS[1], Status: 'Running', Name: 'Updated Other' };
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([initial, TASKS[1]]);
    userEvent.click(screen.getByRole('button', { name: 'View details and log for Build' }));
    await screen.findByText('No log output.');
    const dialog = screen.getByRole('dialog', { name: 'Build' });
    const signal = fetch.mock.calls[0][1].signal;
    act(() => { app.current.handleTaskDeleted(initial); });
    await act(async () => {
        send(FakeWebSocket.instances[0], latest);
        send(FakeWebSocket.instances[0], other);
        finishDelete({ ok: true });
        await Promise.resolve();
    });
    expect(app.current.state.tasks).toEqual([other]);
    expect(within(dialog).getByText('Failed')).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: 'Build attribution' }).textContent).toBe('OriginUsername');
    expect(within(dialog).getByRole('status')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]).toEqual(['/api/v1/tasks/passed-1', { method: 'DELETE' }]);
    expect(signal.aborted).toBe(false);
});

test('App retains only the open selection and clears it on close and tab changes', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404 }));
    const first = { ...TASKS[0], Name: 'First' };
    const second = { ...TASKS[0], id: 'second', Name: 'Second' };
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([first, second]);
    userEvent.click(screen.getByRole('button', { name: 'View details and log for First' }));
    await screen.findByText('No log output.');
    expect(app.current.state.selectedTask).toEqual(first);
    act(() => { send(FakeWebSocket.instances[0], { ...second, Identity: 'unrelated update' }); });
    expect(app.current.state.selectedTask).toEqual(first);
    userEvent.click(screen.getByRole('button', { name: 'Close task details' }));
    expect(app.current.state.selectedTask).toBeNull();
    act(() => { jest.advanceTimersByTime(300); });
    userEvent.click(screen.getByRole('button', { name: 'View details and log for First' }));
    await screen.findByText('No log output.');
    expect(app.current.state.selectedTask).toEqual(first);
    act(() => { app.current.handleMenuItemChange(null, 1); });
    expect(app.current.state.selectedTask).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => { send(FakeWebSocket.instances[0], { ...first, Build: { Origin: 'not selected' } }); });
    expect(app.current.state.selectedTask).toBeNull();
    act(() => { app.current.handleMenuItemChange(null, 0); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test.each([0, 1])('overflow on socket %s promptly replaces both streams and recovers from snapshots', (index) => {
    const initial = { ...task('attributed-task', 'Queued', 30000, null), Build: null };
    const updated = { ...initial, Build: { Origin: 'https://ci.example.com/new', Username: 'alice' } };
    const worker = { id: 'worker', TaskStatus: 'Idle', Hostname: 'new worker' };
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([initial]);
    const [taskSocket, workerSocket] = FakeWebSocket.instances;
    const staleClose = taskSocket.onclose;

    act(() => {
        FakeWebSocket.instances[index].onclose({ code: 1013 });
        jest.advanceTimersByTime(0);
    });

    // Keep the previous view until the new stream's complete snapshot arrives.
    expect(app.current.state.tasks).toEqual([initial]);
    expect(app.current.state.workers).toEqual([]);
    snapshot([updated], [worker], 2);
    expect(app.current.state.tasks).toEqual([updated]);
    expect(app.current.state.workers).toEqual([worker]);
    expect(taskSocket.close).toHaveBeenCalledTimes(1);
    expect(workerSocket.close).toHaveBeenCalledTimes(1);
    expect(taskSocket.onclose).toBeNull();
    expect(workerSocket.onclose).toBeNull();
    expect(FakeWebSocket.instances.slice(2).map((socket) => socket.url)).toEqual([
        'ws://localhost/api/v1/tasks/events', 'ws://localhost/api/v1/workers/events',
    ]);

    act(() => {
        staleClose({ code: 1013 });
        jest.advanceTimersByTime(10000);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(4);
});

test('simultaneous overflows coalesce and accelerate an ordinary pending reconnect', () => {
    render(<App />);
    snapshot();
    const [taskSocket, workerSocket] = FakeWebSocket.instances;

    act(() => {
        taskSocket.onclose({ code: 1006 });
        jest.advanceTimersByTime(1000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => {
        workerSocket.onclose({ code: 1013 });
        taskSocket.onclose({ code: 1013 });
        jest.advanceTimersByTime(0);
    });
    expect(FakeWebSocket.instances).toHaveLength(4);
    act(() => { jest.advanceTimersByTime(10000); });
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(fetch).not.toHaveBeenCalled();
});

test('older socket snapshots and updates cannot replace lists from a newer reconnect', () => {
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot();

    const staleMessages = [];
    for (const index of [0, 2]) {
        staleMessages.push(...FakeWebSocket.instances.slice(index).map((socket) => socket.onmessage));
        act(() => {
            FakeWebSocket.instances[index].onclose({ code: 1013 });
            jest.advanceTimersByTime(0);
        });
    }
    const currentTask = { ...TASKS[0], Build: { Origin: 'current origin', Username: 'alice' } };
    const currentWorker = { id: 'current-worker', Hostname: 'current worker', TaskStatus: 'Idle' };
    snapshot([currentTask], [currentWorker], 4);
    expect(app.current.state.tasks).toEqual([currentTask]);
    expect(app.current.state.workers).toEqual([currentWorker]);

    // Even callbacks captured before detachment must not undo the recovery.
    act(() => {
        staleMessages.forEach((onmessage, index) => {
            onmessage({ data: JSON.stringify({ type: 'snapshot', items: [] }) });
            onmessage({ data: JSON.stringify(index % 2 === 0 ? TASKS[1] : { ...currentWorker, TaskStatus: 'Deleted' }) });
        });
    });
    expect(app.current.state.tasks).toEqual([currentTask]);
    expect(app.current.state.workers).toEqual([currentWorker]);
    expect(fetch).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(6);
});

test.each([0, 1])('ordinary closure on socket %s retains the ten-second reconnect delay', (index) => {
    render(<App />);
    snapshot();
    act(() => {
        FakeWebSocket.instances[index].onclose({ code: 1006 });
        jest.advanceTimersByTime(9999);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => { jest.advanceTimersByTime(1); });
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(fetch).not.toHaveBeenCalled();
});

test('pause cancels pending reconnects and ignores overflow until updates resume', () => {
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot();
    const [taskSocket, workerSocket] = FakeWebSocket.instances;
    const staleClose = workerSocket.onclose;
    act(() => {
        taskSocket.onclose({ code: 1013 });
        app.current.onPause();
    });
    act(() => {
        staleClose({ code: 1013 });
        jest.advanceTimersByTime(10000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(taskSocket.close).toHaveBeenCalledTimes(1);
    expect(workerSocket.close).toHaveBeenCalledTimes(1);
    act(() => { app.current.onPlay(); });
    expect(FakeWebSocket.instances).toHaveLength(4);
    snapshot([], [], 2);
    expect(app.current.state.tasks).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
});

test('unmount cancels an overflow reconnect and closes both sockets without reconnecting', () => {
    const { unmount } = render(<App />);
    snapshot();
    const [taskSocket, workerSocket] = FakeWebSocket.instances;
    const staleClose = workerSocket.onclose;
    act(() => { taskSocket.onclose({ code: 1013 }); });
    unmount();
    act(() => {
        staleClose({ code: 1013 });
        jest.advanceTimersByTime(10000);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(taskSocket.close).toHaveBeenCalledTimes(1);
    expect(workerSocket.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
});

test.each([false, true])('stale snapshots and updates are ignored after unmount (initialized: %s)', (initialized) => {
    const app = React.createRef();
    const { unmount } = render(<App ref={app} />);
    if (initialized) snapshot();
    const staleMessages = FakeWebSocket.instances.map((socket) => socket.onmessage);
    const setState = jest.spyOn(app.current, 'setState');
    unmount();
    act(() => {
        staleMessages.forEach((onmessage, index) => {
            onmessage({ data: JSON.stringify({ type: 'snapshot', items: [] }) });
            onmessage({ data: JSON.stringify(index === 0 ? TASKS[0] : { id: 'worker', TaskStatus: 'Idle' }) });
        });
    });
    expect(setState).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
});

test('queue time keeps counting up while a task sits in the queue', () => {
    render(<App />);
    snapshot();

    // Nothing changes but the wall clock, which fake timers advance along
    // with the timers: the task queued 30s ago has now been waiting 90s, so
    // the metrics have to move with it.
    act(() => { jest.advanceTimersByTime(60000); });

    expect(metric('Queue Time (qmax)')).toBe('1m 30s');
});

test('the metrics timer is stopped when the dashboard unmounts', () => {
    const { unmount } = render(<App />);
    snapshot();

    unmount();
    expect(jest.getTimerCount()).toBe(0);
});

test('task and worker snapshots replace their own lists independently, and empty snapshots clear stale rows', () => {
    const worker = { id: 'worker', TaskStatus: 'Idle', Hostname: 'old worker' };
    const currentTask = task('current-task', 'Running', 10000, 5000);
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot(TASKS, [worker]);
    act(() => {
        FakeWebSocket.instances[0].onclose({ code: 1013 });
        jest.advanceTimersByTime(0);
    });
    expect(app.current.state.tasks).toEqual(TASKS);
    expect(app.current.state.workers).toEqual([worker]);
    act(() => { send(FakeWebSocket.instances[2], { type: 'snapshot', items: [currentTask] }); });
    expect(app.current.state.tasks).toEqual([currentTask]);
    expect(app.current.state.workers).toEqual([worker]);
    act(() => { send(FakeWebSocket.instances[3], { type: 'snapshot', items: [] }); });
    expect(app.current.state.workers).toEqual([]);
    act(() => {
        FakeWebSocket.instances[2].onclose({ code: 1013 });
        jest.advanceTimersByTime(0);
    });
    snapshot([], [], 4);
    expect(app.current.state.tasks).toEqual([]);
    expect(metric('In Progress')).toBe('0');
    expect(metric('Queue Time (qmax)')).toBe('0s');
    expect(fetch).not.toHaveBeenCalled();
});

test('snapshots followed by raw updates and deletes in the same React batch preserve message order', () => {
    const app = React.createRef();
    render(<App ref={app} />);
    const [taskSocket, workerSocket] = FakeWebSocket.instances;
    const latest = { ...TASKS[1], Status: 'Running', Build: { Origin: 'latest origin', Username: 'alice' } };
    const worker = { id: 'worker', TaskStatus: 'Idle', Hostname: 'initial worker' };
    const deletedWorker = { id: 'deleted-worker', TaskStatus: 'Idle', Hostname: 'deleted worker' };
    const latestWorker = { ...worker, TaskStatus: 'Running', Hostname: 'latest worker' };
    act(() => {
        send(taskSocket, { type: 'snapshot', items: TASKS });
        send(workerSocket, { type: 'snapshot', items: [worker, deletedWorker] });
        send(taskSocket, { ...TASKS[1], Build: { Origin: 'older origin' } });
        send(workerSocket, { ...worker, Hostname: 'older worker' });
        send(taskSocket, latest);
        send(workerSocket, latestWorker);
        send(taskSocket, { ...TASKS[0], Status: 'Deleted' });
        send(workerSocket, { ...deletedWorker, TaskStatus: 'Deleted' });
        send(taskSocket, task('transient', 'Queued', 0, null));
        send(taskSocket, { id: 'transient', Status: 'Deleted' });
        send(workerSocket, { id: 'transient', TaskStatus: 'Idle' });
        send(workerSocket, { id: 'transient', TaskStatus: 'Deleted' });
    });
    expect(app.current.state.tasks).toEqual([latest]);
    expect(app.current.state.workers).toEqual([latestWorker]);
    expect(metric('In Queue')).toBe('0');
    expect(metric('In Progress')).toBe('1');
    expect(fetch).not.toHaveBeenCalled();
});

test('worker raw updates replace full views and deletes remove only the matching worker', () => {
    const worker = { id: 'worker', TaskStatus: 'Idle', Hostname: 'initial worker' };
    const other = { id: 'other', TaskStatus: 'Idle', Hostname: 'other worker' };
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([], [worker, other]);
    const socket = FakeWebSocket.instances[1];
    const updated = { ...worker, TaskStatus: 'Running', TaskName: 'new task' };
    act(() => { send(socket, updated); });
    expect(app.current.state.workers).toEqual([other, updated]);
    act(() => { send(socket, { id: worker.id, TaskStatus: 'Idle' }); });
    expect(app.current.state.workers).toEqual([other, { id: worker.id, TaskStatus: 'Idle' }]);
    act(() => { send(socket, { id: worker.id, TaskStatus: 'Deleted' }); });
    expect(app.current.state.workers).toEqual([other]);
    expect(fetch).not.toHaveBeenCalled();
});

test('idle workers with the backend empty TaskStatus survive snapshots and incremental updates', () => {
    const idle = { id: 'worker', TaskStatus: '', TaskName: '', TaskInstance: '', Hostname: 'idle worker' };
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([], [idle]);
    expect(app.current.state.workers).toEqual([idle]);
    const socket = FakeWebSocket.instances[1];
    act(() => { send(socket, { ...idle, TaskStatus: 'Running', TaskName: 'task' }); });
    act(() => { send(socket, idle); });
    expect(app.current.state.workers).toEqual([idle]);
    expect(socket.close).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
});

test.each([0, 1])('ordinary disconnect while socket %s awaits a snapshot immediately invalidates old callbacks', (index) => {
    const app = React.createRef();
    render(<App ref={app} />);
    const socket = FakeWebSocket.instances[index];
    const staleMessage = socket.onmessage;
    const items = index === 0 ? TASKS : [{ id: 'worker', TaskStatus: 'Idle' }];
    act(() => {
        socket.onclose({ code: 1006 });
        staleMessage({ data: JSON.stringify({ type: 'snapshot', items }) });
        staleMessage({ data: JSON.stringify(items[0]) });
        jest.advanceTimersByTime(9999);
    });
    expect(app.current.state.tasks).toEqual([]);
    expect(app.current.state.workers).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => { jest.advanceTimersByTime(1); });
    snapshot([], [], 2);
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(fetch).not.toHaveBeenCalled();
});

test.each([false, true])('pause before fresh snapshots (existing view: %s) closes streams and resume bootstraps anew', (existingView) => {
    const app = React.createRef();
    render(<App ref={app} />);
    let offset = 0;
    if (existingView) {
        snapshot();
        act(() => {
            FakeWebSocket.instances[0].onclose({ code: 1013 });
            jest.advanceTimersByTime(0);
        });
        offset = 2;
    }
    const sockets = FakeWebSocket.instances.slice(offset);
    const staleMessages = sockets.map((socket) => socket.onmessage);
    act(() => { app.current.onPause(); });
    const setState = jest.spyOn(app.current, 'setState');
    act(() => {
        staleMessages.forEach((onmessage) => {
            onmessage({ data: JSON.stringify({ type: 'snapshot', items: [] }) });
            onmessage({ data: JSON.stringify(TASKS[0]) });
        });
        jest.advanceTimersByTime(10000);
    });
    expect(setState).not.toHaveBeenCalled();
    expect(app.current.state.tasks).toEqual(existingView ? TASKS : []);
    expect(app.current.state.workers).toEqual([]);
    sockets.forEach((socket) => {
        expect(socket.close).toHaveBeenCalledTimes(1);
        expect(socket.onmessage).toBeNull();
        expect(socket.onclose).toBeNull();
    });
    expect(FakeWebSocket.instances).toHaveLength(offset + 2);
    act(() => { app.current.onPlay(); });
    snapshot([TASKS[0]], [], offset + 2);
    expect(app.current.state.tasks).toEqual([TASKS[0]]);
    expect(fetch).not.toHaveBeenCalled();
});

test.each([0, 1])('ordinary closes on both streams coalesce into one reconnect (first: %s)', (index) => {
    render(<App />);
    snapshot();
    act(() => {
        FakeWebSocket.instances[index].onclose({ code: 1006 });
        jest.advanceTimersByTime(1000);
        FakeWebSocket.instances[1 - index].onclose({ code: 1006 });
        jest.advanceTimersByTime(8999);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => { jest.advanceTimersByTime(1); });
    expect(FakeWebSocket.instances).toHaveLength(4);
    act(() => { jest.advanceTimersByTime(10000); });
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(fetch).not.toHaveBeenCalled();
});

const INVALID_FRAMES = [
    ['raw update before snapshot', false, (index) => JSON.stringify(index === 0 ? TASKS[0] : { id: 'worker', TaskStatus: 'Idle' })],
    ['invalid JSON', false, () => '{'],
    ['null frame', false, () => 'null'],
    ['array frame', false, () => '[]'],
    ['unknown envelope', false, () => JSON.stringify({ type: 'update', items: [] })],
    ['null snapshot items', false, () => JSON.stringify({ type: 'snapshot', items: null })],
    ['invalid snapshot item', false, () => JSON.stringify({ type: 'snapshot', items: [{}] })],
    ['missing update id', true, (index) => JSON.stringify(index === 0 ? { Status: 'Queued' } : { TaskStatus: 'Idle' })],
    ['missing update status', true, () => JSON.stringify({ id: 'missing-status' })],
    ['duplicate snapshot', true, () => JSON.stringify({ type: 'snapshot', items: [] })],
];

describe.each([0, 1])('invalid frames on socket %s', (index) => {
    test.each(INVALID_FRAMES)('%s closes the stream and reconnects with ordinary backoff', (name, initialized, data) => {
        const worker = { id: 'worker', TaskStatus: 'Idle', Hostname: 'worker' };
        const app = React.createRef();
        render(<App ref={app} />);
        snapshot(TASKS, [worker]);
        let offset = 0;
        if (!initialized) {
            act(() => {
                FakeWebSocket.instances[index].onclose({ code: 1013 });
                jest.advanceTimersByTime(0);
            });
            offset = 2;
        }
        const socket = FakeWebSocket.instances[offset + index];
        const staleMessage = socket.onmessage;
        act(() => {
            staleMessage({ data: data(index) });
            // A failed stream must neither buffer nor apply later frames, even
            // before the browser reports close or the backoff timer expires.
            staleMessage({ data: JSON.stringify({ type: 'snapshot', items: [] }) });
            staleMessage({ data: JSON.stringify(index === 0 ? { ...TASKS[0], Status: 'Deleted' } : { ...worker, TaskStatus: 'Deleted' }) });
        });
        expect(app.current.state.tasks).toEqual(TASKS);
        expect(app.current.state.workers).toEqual([worker]);
        expect(socket.close).toHaveBeenCalledTimes(1);
        act(() => { jest.advanceTimersByTime(9999); });
        expect(FakeWebSocket.instances).toHaveLength(offset + 2);
        act(() => { jest.advanceTimersByTime(1); });
        expect(FakeWebSocket.instances).toHaveLength(offset + 4);
        snapshot([], [], offset + 2);
        expect(app.current.state.tasks).toEqual([]);
        expect(app.current.state.workers).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
    });
});

test.each(['http:', 'https:'])('websocket URLs use the matching scheme for %s', (protocol) => {
    const app = new App({});
    const location = window.location;
    delete window.location;
    window.location = { protocol, host: 'dashboard.example.com:8082' };
    try {
        const scheme = protocol === 'https:' ? 'wss' : 'ws';
        expect(app.websocketUrl('/api/v1/tasks/events')).toBe(`${scheme}://dashboard.example.com:8082/api/v1/tasks/events`);
        expect(app.websocketUrl('/api/v1/workers/events')).toBe(`${scheme}://dashboard.example.com:8082/api/v1/workers/events`);
    } finally {
        window.location = location;
    }
});

test('deleting a task still uses REST DELETE without fetching either list', async () => {
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot();
    await act(async () => { app.current.handleTaskDeleted(TASKS[0]); });
    expect(fetch.mock.calls).toEqual([['/api/v1/tasks/passed-1', { method: 'DELETE' }]]);
    expect(app.current.state.tasks).toEqual([TASKS[1]]);
    expect(metric('In Queue')).toBe('1');
});
