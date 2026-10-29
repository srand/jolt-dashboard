import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

import App from './App';
import * as auth from './auth';

// Whether signing in is configured; tests that sign in configure it.
jest.mock('./auth', () => ({ ...jest.requireActual('./auth'), loadConfig: jest.fn() }));

global.TextDecoder = global.TextDecoder || NodeTextDecoder;
global.TextEncoder = global.TextEncoder || NodeTextEncoder;

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

function snapshotFrame(tasks = TASKS, workers = [], builds = []) {
    return { type: 'snapshot', tasks, workers, builds };
}

// Sends a snapshot on the socket of the given connection; every reconnect
// opens one new socket.
function snapshot(tasks = TASKS, workers = [], offset = 0, builds = []) {
    act(() => {
        send(FakeWebSocket.instances[offset], snapshotFrame(tasks, workers, builds));
    });
}

function update(socket, type, item) {
    send(socket, { type, item });
}

// The dashboard opens on the builds tab.
function openTasks() {
    userEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
}

function metric(name) {
    return screen.getByText(name).parentElement.querySelector('h2').textContent;
}

beforeEach(() => {
    FakeWebSocket.instances = [];
    global.WebSocket = FakeWebSocket;
    global.fetch = jest.fn(() => Promise.resolve({ json: () => Promise.resolve([]) }));
    auth.loadConfig.mockResolvedValue(null);
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
    expect(socket.url).toBe('ws://localhost/api/v1/events');

    // A task that has been queued for ten minutes shows up.
    act(() => {
        update(socket, 'task', task('queued-2', 'Queued', 600000, null));
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
    openTasks();

    const socket = FakeWebSocket.instances[0];
    const build = {
        Id: 'build', Status: 'BUILD_ACCEPTED', Scheduled: stamp(NOW),
        Origin: 'https://ci.example.com/build/123', Registered: true,
    };
    for (const metadata of [build, { ...build, Origin: '', Registered: false }, null]) {
        const updated = { ...initial, Build: metadata };
        act(() => {
            update(socket, 'task', updated);
        });
        expect(app.current.state.tasks).toEqual([updated]);
        expect(metric('In Queue')).toBe('1');
    }

    act(() => {
        update(socket, 'task', { ...initial, Status: 'Deleted' });
    });
    expect(app.current.state.tasks).toEqual([]);
    expect(metric('In Queue')).toBe('0');
    expect(fetch).not.toHaveBeenCalled();
});

describe.each(['Deleted event', 'reconnect empty snapshot'])('open task removed by %s', (removal) => {
    test.each([
        ['updated attribution', { Origin: 'latest origin' }],
        ['null build', null],
        ['empty attribution', { Origin: '' }],
    ])('retains the latest full update in the same React batch: %s', async (name, build) => {
        const reader = { read: jest.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('retained log output\n') })
            .mockResolvedValue({ done: true }) };
        global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, body: { getReader: () => reader } }));
        const initial = {
            ...task('selected-task', 'Running', 30000, 20000), Name: 'Opening Build',
            Identity: 'opening identity', Ended: stamp(NOW - 10000), Log: 'opening log',
            Build: { Origin: 'opening origin' },
        };
        const latest = {
            ...initial, Name: 'Latest Build', Identity: '', Status: 'Failed', Log: '', Build: build,
            Started: build?.Origin ? stamp(NOW - 5000) : '', Ended: build?.Origin ? stamp(NOW) : '',
        };
        const app = React.createRef();
        render(<App ref={app} />);
        snapshot([initial]);
    openTasks();
        openTasks();
        userEvent.click(screen.getByRole('button', { name: 'View details and log for Opening Build' }));
        await screen.findByText('retained log output');
        const dialog = screen.getByRole('dialog', { name: 'Opening Build opening identity' });
        expect(within(dialog).getByText('retained log output')).toBeInTheDocument();
        const signal = fetch.mock.calls[0][1].signal;
        const socket = FakeWebSocket.instances[0];

        // Do not render the update separately: Tasks only sees the final empty list.
        act(() => {
            update(socket, 'task', { ...latest, Build: { Origin: 'intermediate origin' } });
            update(socket, 'task', latest);
            if (removal === 'Deleted event') {
                update(socket, 'task', { ...initial, Status: 'Deleted' });
            } else {
                socket.onclose({ code: 1013 });
                jest.advanceTimersByTime(0);
                send(FakeWebSocket.instances[1], snapshotFrame([]));
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
        expect(attribution.textContent).toBe(`${build?.Origin || ''}Origin`);
        expect(within(dialog).queryByText('opening origin')).not.toBeInTheDocument();
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
    const initial = { ...TASKS[0], Name: 'Build', Build: { Origin: 'opening origin' } };
    const latest = { ...initial, Status: 'Failed', Build: { Origin: 'snapshot origin' } };
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([initial]);
    openTasks();
    userEvent.click(screen.getByRole('button', { name: 'View details and log for Build' }));
    await screen.findByText('No log output.');
    const dialog = screen.getByRole('dialog', { name: 'Build' });
    act(() => {
        FakeWebSocket.instances[0].onclose({ code: 1013 });
        jest.advanceTimersByTime(0);
        send(FakeWebSocket.instances[1], snapshotFrame([latest]));
        update(FakeWebSocket.instances[1], 'task', { id: initial.id, Status: 'Deleted' });
    });
    expect(app.current.state.tasks).toEqual([]);
    expect(within(dialog).getByText('Failed')).toBeInTheDocument();
    expect(within(dialog).getByText('snapshot origin')).toBeInTheDocument();
    expect(within(dialog).getByRole('status')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
});

test('App retains only the open selection and clears it on close and tab changes', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404 }));
    const first = { ...TASKS[0], Name: 'First' };
    const second = { ...TASKS[0], id: 'second', Name: 'Second' };
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([first, second]);
    openTasks();
    userEvent.click(screen.getByRole('button', { name: 'View details and log for First' }));
    await screen.findByText('No log output.');
    expect(app.current.state.selectedTask).toEqual(first);
    act(() => { update(FakeWebSocket.instances[0], 'task', { ...second, Identity: 'unrelated update' }); });
    expect(app.current.state.selectedTask).toEqual(first);
    userEvent.click(screen.getByRole('button', { name: 'Close task details' }));
    expect(app.current.state.selectedTask).toBeNull();
    act(() => { jest.advanceTimersByTime(300); });
    userEvent.click(screen.getByRole('button', { name: 'View details and log for First' }));
    await screen.findByText('No log output.');
    expect(app.current.state.selectedTask).toEqual(first);
    act(() => { app.current.handleMenuItemChange(null, 2); });
    expect(app.current.state.selectedTask).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => { update(FakeWebSocket.instances[0], 'task', { ...first, Build: { Origin: 'not selected' } }); });
    expect(app.current.state.selectedTask).toBeNull();
    act(() => { app.current.handleMenuItemChange(null, 1); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('overflow promptly replaces the stream and recovers from a snapshot', () => {
    const initial = { ...task('attributed-task', 'Queued', 30000, null), Build: null };
    const updated = { ...initial, Build: { Origin: 'https://ci.example.com/new' } };
    const worker = { id: 'worker', TaskStatus: 'Idle', Hostname: 'new worker' };
    const build = { id: 'build', Id: 'build', Status: 'BUILD_ACCEPTED' };
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([initial]);
    openTasks();
    const [socket] = FakeWebSocket.instances;
    const staleClose = socket.onclose;

    act(() => {
        socket.onclose({ code: 1013 });
        jest.advanceTimersByTime(0);
    });

    // Keep the previous view until the new stream's complete snapshot arrives.
    expect(app.current.state.tasks).toEqual([initial]);
    expect(app.current.state.workers).toEqual([]);
    snapshot([updated], [worker], 1, [build]);
    expect(app.current.state.tasks).toEqual([updated]);
    expect(app.current.state.workers).toEqual([worker]);
    expect(app.current.state.builds).toEqual([build]);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.onclose).toBeNull();
    expect(FakeWebSocket.instances.slice(1).map((s) => s.url)).toEqual(['ws://localhost/api/v1/events']);

    act(() => {
        staleClose({ code: 1013 });
        jest.advanceTimersByTime(10000);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
});

test('an overflow accelerates an ordinary pending reconnect', () => {
    render(<App />);
    snapshot();
    const [socket] = FakeWebSocket.instances;

    act(() => {
        socket.onclose({ code: 1006 });
        jest.advanceTimersByTime(1000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => {
        socket.onclose({ code: 1013 });
        jest.advanceTimersByTime(0);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => { jest.advanceTimersByTime(10000); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
});

test('older socket snapshots and updates cannot replace lists from a newer reconnect', () => {
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot();

    const staleMessages = [];
    for (const index of [0, 1]) {
        staleMessages.push(FakeWebSocket.instances[index].onmessage);
        act(() => {
            FakeWebSocket.instances[index].onclose({ code: 1013 });
            jest.advanceTimersByTime(0);
        });
    }
    const currentTask = { ...TASKS[0], Build: { Origin: 'current origin' } };
    const currentWorker = { id: 'current-worker', Hostname: 'current worker', TaskStatus: 'Idle' };
    snapshot([currentTask], [currentWorker], 2);
    expect(app.current.state.tasks).toEqual([currentTask]);
    expect(app.current.state.workers).toEqual([currentWorker]);

    // Even callbacks captured before detachment must not undo the recovery.
    act(() => {
        staleMessages.forEach((onmessage) => {
            onmessage({ data: JSON.stringify(snapshotFrame([])) });
            onmessage({ data: JSON.stringify({ type: 'task', item: TASKS[1] }) });
            onmessage({ data: JSON.stringify({ type: 'worker', item: { ...currentWorker, TaskStatus: 'Deleted' } }) });
        });
    });
    expect(app.current.state.tasks).toEqual([currentTask]);
    expect(app.current.state.workers).toEqual([currentWorker]);
    expect(fetch).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(3);
});

test('ordinary closure retains the ten-second reconnect delay', () => {
    render(<App />);
    snapshot();
    act(() => {
        FakeWebSocket.instances[0].onclose({ code: 1006 });
        jest.advanceTimersByTime(9999);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => { jest.advanceTimersByTime(1); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
});

test('repeated closes of the stream reconnect once', () => {
    render(<App />);
    snapshot();
    const [socket] = FakeWebSocket.instances;
    act(() => {
        socket.onclose({ code: 1006 });
        jest.advanceTimersByTime(1000);
        socket.onclose({ code: 1006 });
        jest.advanceTimersByTime(8999);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => { jest.advanceTimersByTime(1); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => { jest.advanceTimersByTime(10000); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
});

test('pause cancels pending reconnects and ignores overflow until updates resume', () => {
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot();
    const [socket] = FakeWebSocket.instances;
    const staleClose = socket.onclose;
    act(() => {
        socket.onclose({ code: 1013 });
        app.current.onPause();
    });
    act(() => {
        staleClose({ code: 1013 });
        jest.advanceTimersByTime(10000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    act(() => { app.current.onPlay(); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    snapshot([], [], 1);
    expect(app.current.state.tasks).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
});

test('unmount cancels an overflow reconnect and closes the socket without reconnecting', () => {
    const { unmount } = render(<App />);
    snapshot();
    const [socket] = FakeWebSocket.instances;
    const staleClose = socket.onclose;
    act(() => { socket.onclose({ code: 1013 }); });
    unmount();
    act(() => {
        staleClose({ code: 1013 });
        jest.advanceTimersByTime(10000);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
});

test.each([false, true])('stale snapshots and updates are ignored after unmount (initialized: %s)', (initialized) => {
    const app = React.createRef();
    const { unmount } = render(<App ref={app} />);
    if (initialized) snapshot();
    const [{ onmessage }] = FakeWebSocket.instances;
    const setState = jest.spyOn(app.current, 'setState');
    unmount();
    act(() => {
        onmessage({ data: JSON.stringify(snapshotFrame([])) });
        onmessage({ data: JSON.stringify({ type: 'task', item: TASKS[0] }) });
        onmessage({ data: JSON.stringify({ type: 'worker', item: { id: 'worker', TaskStatus: 'Idle' } }) });
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

test('a reconnect snapshot replaces all lists, and empty snapshots clear stale rows', () => {
    const worker = { id: 'worker', TaskStatus: 'Idle', Hostname: 'old worker' };
    const build = { id: 'build', Id: 'build', Status: 'BUILD_ACCEPTED' };
    const currentTask = task('current-task', 'Running', 10000, 5000);
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot(TASKS, [worker], 0, [build]);
    act(() => {
        FakeWebSocket.instances[0].onclose({ code: 1013 });
        jest.advanceTimersByTime(0);
    });
    expect(app.current.state.tasks).toEqual(TASKS);
    expect(app.current.state.workers).toEqual([worker]);
    snapshot([currentTask], [], 1, []);
    expect(app.current.state.tasks).toEqual([currentTask]);
    expect(app.current.state.workers).toEqual([]);
    expect(app.current.state.builds).toEqual([]);
    act(() => {
        FakeWebSocket.instances[1].onclose({ code: 1013 });
        jest.advanceTimersByTime(0);
    });
    snapshot([], [], 2);
    expect(app.current.state.tasks).toEqual([]);
    expect(metric('In Progress')).toBe('0');
    expect(metric('Queue Time (qmax)')).toBe('0s');
    expect(fetch).not.toHaveBeenCalled();
});

test('a snapshot followed by updates and deletes in the same React batch preserves message order', () => {
    const app = React.createRef();
    render(<App ref={app} />);
    const [socket] = FakeWebSocket.instances;
    const latest = { ...TASKS[1], Status: 'Running', Build: { Origin: 'latest origin' } };
    const worker = { id: 'worker', TaskStatus: 'Idle', Hostname: 'initial worker' };
    const deletedWorker = { id: 'deleted-worker', TaskStatus: 'Idle', Hostname: 'deleted worker' };
    const latestWorker = { ...worker, TaskStatus: 'Running', Hostname: 'latest worker' };
    const build = { id: 'build', Id: 'build', Status: 'BUILD_ACCEPTED' };
    const latestBuild = { ...build, Status: 'BUILD_CANCELLED' };
    act(() => {
        send(socket, snapshotFrame(TASKS, [worker, deletedWorker], [build]));
        update(socket, 'task', { ...TASKS[1], Build: { Origin: 'older origin' } });
        update(socket, 'worker', { ...worker, Hostname: 'older worker' });
        update(socket, 'task', latest);
        update(socket, 'worker', latestWorker);
        update(socket, 'build', latestBuild);
        update(socket, 'task', { ...TASKS[0], Status: 'Deleted' });
        update(socket, 'worker', { ...deletedWorker, TaskStatus: 'Deleted' });
        update(socket, 'task', task('transient', 'Queued', 0, null));
        update(socket, 'task', { id: 'transient', Status: 'Deleted' });
        update(socket, 'worker', { id: 'transient', TaskStatus: 'Idle' });
        update(socket, 'worker', { id: 'transient', TaskStatus: 'Deleted' });
        update(socket, 'build', { id: 'transient', Status: 'BUILD_ACCEPTED' });
        update(socket, 'build', { id: 'transient', Status: 'Deleted' });
    });
    expect(app.current.state.tasks).toEqual([latest]);
    expect(app.current.state.workers).toEqual([latestWorker]);
    expect(app.current.state.builds).toEqual([latestBuild]);
    expect(metric('In Queue')).toBe('0');
    expect(metric('In Progress')).toBe('1');
    expect(fetch).not.toHaveBeenCalled();
});

test('worker updates replace full views and deletes remove only the matching worker', () => {
    const worker = { id: 'worker', TaskStatus: 'Idle', Hostname: 'initial worker' };
    const other = { id: 'other', TaskStatus: 'Idle', Hostname: 'other worker' };
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([], [worker, other]);
    const socket = FakeWebSocket.instances[0];
    const updated = { ...worker, TaskStatus: 'Running', TaskName: 'new task' };
    act(() => { update(socket, 'worker', updated); });
    expect(app.current.state.workers).toEqual([other, updated]);
    act(() => { update(socket, 'worker', { id: worker.id, TaskStatus: 'Idle' }); });
    expect(app.current.state.workers).toEqual([other, { id: worker.id, TaskStatus: 'Idle' }]);
    act(() => { update(socket, 'worker', { id: worker.id, TaskStatus: 'Deleted' }); });
    expect(app.current.state.workers).toEqual([other]);
    expect(fetch).not.toHaveBeenCalled();
});

test('idle workers with the backend empty TaskStatus survive snapshots and incremental updates', () => {
    const idle = { id: 'worker', TaskStatus: '', TaskName: '', TaskInstance: '', Hostname: 'idle worker' };
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([], [idle]);
    expect(app.current.state.workers).toEqual([idle]);
    const socket = FakeWebSocket.instances[0];
    act(() => { update(socket, 'worker', { ...idle, TaskStatus: 'Running', TaskName: 'task' }); });
    act(() => { update(socket, 'worker', idle); });
    expect(app.current.state.workers).toEqual([idle]);
    expect(socket.close).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
});

test('an ordinary disconnect while awaiting a snapshot immediately invalidates old callbacks', () => {
    const app = React.createRef();
    render(<App ref={app} />);
    const socket = FakeWebSocket.instances[0];
    const staleMessage = socket.onmessage;
    act(() => {
        socket.onclose({ code: 1006 });
        staleMessage({ data: JSON.stringify(snapshotFrame(TASKS, [{ id: 'worker', TaskStatus: 'Idle' }])) });
        staleMessage({ data: JSON.stringify({ type: 'task', item: TASKS[0] }) });
        jest.advanceTimersByTime(9999);
    });
    expect(app.current.state.tasks).toEqual([]);
    expect(app.current.state.workers).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => { jest.advanceTimersByTime(1); });
    snapshot([], [], 1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
});

test.each([false, true])('pause before a fresh snapshot (existing view: %s) closes the stream and resume bootstraps anew', (existingView) => {
    const app = React.createRef();
    render(<App ref={app} />);
    let offset = 0;
    if (existingView) {
        snapshot();
        act(() => {
            FakeWebSocket.instances[0].onclose({ code: 1013 });
            jest.advanceTimersByTime(0);
        });
        offset = 1;
    }
    const socket = FakeWebSocket.instances[offset];
    const staleMessage = socket.onmessage;
    act(() => { app.current.onPause(); });
    const setState = jest.spyOn(app.current, 'setState');
    act(() => {
        staleMessage({ data: JSON.stringify(snapshotFrame([])) });
        staleMessage({ data: JSON.stringify({ type: 'task', item: TASKS[0] }) });
        jest.advanceTimersByTime(10000);
    });
    expect(setState).not.toHaveBeenCalled();
    expect(app.current.state.tasks).toEqual(existingView ? TASKS : []);
    expect(app.current.state.workers).toEqual([]);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.onmessage).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(offset + 1);
    act(() => { app.current.onPlay(); });
    snapshot([TASKS[0]], [], offset + 1);
    expect(app.current.state.tasks).toEqual([TASKS[0]]);
    expect(fetch).not.toHaveBeenCalled();
});

const INVALID_FRAMES = [
    ['update before snapshot', false, JSON.stringify({ type: 'task', item: TASKS[0] })],
    ['invalid JSON', false, '{'],
    ['null frame', false, 'null'],
    ['array frame', false, '[]'],
    ['unknown envelope', false, JSON.stringify({ type: 'update', tasks: [], workers: [], builds: [] })],
    ['null snapshot list', false, JSON.stringify({ type: 'snapshot', tasks: null, workers: [], builds: [] })],
    ['missing snapshot list', false, JSON.stringify({ type: 'snapshot', tasks: [], workers: [] })],
    ['invalid snapshot item', false, JSON.stringify({ type: 'snapshot', tasks: [{}], workers: [], builds: [] })],
    ['missing update id', true, JSON.stringify({ type: 'task', item: { Status: 'Queued' } })],
    ['missing update status', true, JSON.stringify({ type: 'worker', item: { id: 'missing-status' } })],
    ['unknown update type', true, JSON.stringify({ type: 'gadget', item: { id: 'gadget', Status: 'Queued' } })],
    ['raw item without envelope', true, JSON.stringify(TASKS[0])],
    ['duplicate snapshot', true, JSON.stringify(snapshotFrame([]))],
];

test.each(INVALID_FRAMES)('%s closes the stream and reconnects with ordinary backoff', (name, initialized, data) => {
    const worker = { id: 'worker', TaskStatus: 'Idle', Hostname: 'worker' };
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot(TASKS, [worker]);
    let offset = 0;
    if (!initialized) {
        act(() => {
            FakeWebSocket.instances[0].onclose({ code: 1013 });
            jest.advanceTimersByTime(0);
        });
        offset = 1;
    }
    const socket = FakeWebSocket.instances[offset];
    const staleMessage = socket.onmessage;
    act(() => {
        staleMessage({ data });
        // A failed stream must neither buffer nor apply later frames, even
        // before the browser reports close or the backoff timer expires.
        staleMessage({ data: JSON.stringify(snapshotFrame([])) });
        staleMessage({ data: JSON.stringify({ type: 'worker', item: { ...worker, TaskStatus: 'Deleted' } }) });
    });
    expect(app.current.state.tasks).toEqual(TASKS);
    expect(app.current.state.workers).toEqual([worker]);
    expect(socket.close).toHaveBeenCalledTimes(1);
    act(() => { jest.advanceTimersByTime(9999); });
    expect(FakeWebSocket.instances).toHaveLength(offset + 1);
    act(() => { jest.advanceTimersByTime(1); });
    expect(FakeWebSocket.instances).toHaveLength(offset + 2);
    snapshot([], [], offset + 1);
    expect(app.current.state.tasks).toEqual([]);
    expect(app.current.state.workers).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
});

test.each(['http:', 'https:'])('websocket URLs use the matching scheme for %s', (protocol) => {
    const app = new App({});
    const location = window.location;
    delete window.location;
    window.location = { protocol, host: 'dashboard.example.com:8082' };
    try {
        const scheme = protocol === 'https:' ? 'wss' : 'ws';
        expect(app.websocketUrl('/api/v1/events')).toBe(`${scheme}://dashboard.example.com:8082/api/v1/events`);
    } finally {
        window.location = location;
    }
});

// Builds

const BUILD = {
    id: 'build-0123456789abcdef', Id: 'build-0123456789abcdef', Status: 'BUILD_ACCEPTED', Scheduled: stamp(NOW - 60000), Origin: 'https://ci.example.com/build/7', Registered: true,
    Parameters: [{ Key: 'config.branch', Value: 'main' }],
    Owners: ['alice'],
};
const BUILD_TASKS = [
    { ...task('build-task-1', 'Passed', 60000, 50000), Name: 'Compile', BuildId: BUILD.id, Ended: stamp(NOW - 40000), Build: BUILD },
    { ...task('build-task-2', 'Running', 30000, 20000), Name: 'Link', BuildId: BUILD.id, Build: BUILD },
];
const OTHER_TASK = { ...task('other-task', 'Queued', 10000, null), Name: 'Other', BuildId: 'other-build' };
const WORKERS = [
    { id: 'busy', Hostname: 'busy worker', TaskStatus: 'Running', TaskInstance: 'build-task-2', TaskName: 'Link' },
    { id: 'idle', Hostname: 'idle worker', TaskStatus: '', TaskInstance: '' },
];

function idToken(claims) {
    const encode = (value) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`;
}

function signInAs(name) {
    window.sessionStorage.setItem('jolt-dashboard.auth.v1', JSON.stringify({
        config: { issuer: 'https://idp/realms/jolt', clientId: 'jolt' },
        idToken: idToken({ preferred_username: name, exp: NOW / 1000 + 3600 }),
        refreshToken: null,
    }));
}

afterEach(() => {
    window.sessionStorage.clear();
});

function openBuilds() {
    userEvent.click(screen.getByRole('tab', { name: 'Builds' }));
}

test('the builds tab lists the builds of the scheduler with the statistics of their tasks', () => {
    render(<App />);
    snapshot([...BUILD_TASKS, OTHER_TASK], WORKERS, 0, [BUILD, { ...BUILD, id: 'idle-build', Id: 'idle-build', Owners: [] }]);
    openBuilds();

    const table = screen.getByRole('table', { name: 'Builds' });
    const row = within(table).getByText('build-012345').closest('tr');
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(within(row).getByText('1 Running')).toBeInTheDocument();
    // A build without tasks still has a row, and so does a build only tasks know
    expect(within(table).getByText('idle-build')).toBeInTheDocument();
    expect(within(table).getByText('other-build')).toBeInTheDocument();

    userEvent.click(within(row).getByRole('button', { name: 'Expand build' }));
    const parameters = screen.getByRole('table', { name: 'Build parameters' });
    expect(within(parameters).getByText('branch')).toBeInTheDocument();
    expect(within(parameters).getByText('main')).toBeInTheDocument();
    const statistics = screen.getByRole('table', { name: 'Task statistics' });
    expect(within(within(statistics).getByText('Total').closest('tr')).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Build details' })).getByText('alice')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
});

test('a build filter shows only the tasks and workers of the build', () => {
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([...BUILD_TASKS, OTHER_TASK], WORKERS, 0, [BUILD]);
    openBuilds();
    const row = screen.getByText('build-012345').closest('tr');
    userEvent.click(within(row).getByRole('button', { name: 'Filter by build' }));
    expect(app.current.state.buildFilter).toBe(BUILD.id);

    userEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
    expect(screen.getByText('Compile')).toBeInTheDocument();
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
    userEvent.click(screen.getByRole('tab', { name: 'Workers' }));
    expect(screen.getByText('busy worker')).toBeInTheDocument();
    expect(screen.queryByText('idle worker')).not.toBeInTheDocument();

    // The chip clears the filter
    userEvent.click(within(screen.getByText('Build build-012345').closest('[role="button"]')).getByTestId('CancelIcon'));
    expect(app.current.state.buildFilter).toBeNull();
    expect(screen.getByText('idle worker')).toBeInTheDocument();
});

test('the build button of a task shows its build, expanded', () => {
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot([...BUILD_TASKS, { ...OTHER_TASK, BuildId: '' }], [], 0, [BUILD]);
    openTasks();
    expect(screen.getByRole('button', { name: 'Show the build of Other' })).toBeDisabled();
    userEvent.click(screen.getByRole('button', { name: 'Show the build of Compile' }));
    expect(screen.getByRole('tab', { name: 'Builds' })).toHaveAttribute('aria-selected', 'true');
    expect(app.current.state.expandedBuilds).toEqual([BUILD.id]);
    expect(screen.getByRole('table', { name: 'Build parameters' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
});

test('builds can only be stopped when signed in', async () => {
    auth.loadConfig.mockResolvedValue({ issuer: 'https://idp/realms/jolt', clientId: 'jolt' });
    render(<App />);
    snapshot(BUILD_TASKS, [], 0, [BUILD]);
    openBuilds();
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop build' })).toBeDisabled();
});

test.each([
    ['stops the build', { ok: true, status: 204, json: () => Promise.resolve({}) }, 'The build was stopped'],
    ['reports the refusal of the scheduler', {
        ok: false, status: 403, json: () => Promise.resolve({ error: 'only the owners of a build and administrators may cancel it' }),
    }, 'The build could not be stopped: only the owners of a build and administrators may cancel it'],
])('a signed-in user %s', async (name, response, message) => {
    signInAs('alice');
    global.fetch = jest.fn(() => Promise.resolve(response));
    render(<App />);
    snapshot(BUILD_TASKS, [], 0, [BUILD]);
    openBuilds();
    const user = screen.getByText('alice', { selector: '[aria-label="Signed in as"]' });
    expect(user).toHaveClass('MuiTypography-button');

    userEvent.click(screen.getByRole('button', { name: 'Stop build' }));
    const dialog = screen.getByRole('dialog', { name: 'Stop the build?' });
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
        userEvent.click(within(dialog).getByRole('button', { name: 'Stop build' }));
    });
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(`/api/v1/builds/${BUILD.id}/cancel`);
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toMatch(/^Bearer [^.]+\.[^.]+\.signature$/);
});

test('signing out forgets the user', async () => {
    auth.loadConfig.mockResolvedValue({ issuer: 'https://idp/realms/jolt', clientId: 'jolt' });
    signInAs('alice');
    render(<App />);
    snapshot(BUILD_TASKS, [], 0, [BUILD]);
    userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(window.sessionStorage.getItem('jolt-dashboard.auth.v1')).toBeNull();
});

test('clicking anywhere on a build row expands and collapses it, but its actions do not', () => {
    const app = React.createRef();
    render(<App ref={app} />);
    snapshot(BUILD_TASKS, [], 0, [BUILD]);
    const row = screen.getByText('build-012345').closest('tr');
    userEvent.click(within(row).getByText('Active'));
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('table', { name: 'Build parameters' })).toBeInTheDocument();
    userEvent.click(within(row).getByRole('button', { name: 'Filter by build' }));
    expect(app.current.state.buildFilter).toBe(BUILD.id);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    userEvent.click(within(row).getByText('alice'));
    expect(row).toHaveAttribute('aria-expanded', 'false');
});

test('clicking a builds column header sorts by it, and clicking again reverses the order', () => {
    const older = { ...BUILD, id: 'older-build', Id: 'older-build', Scheduled: stamp(NOW - 600000), Owners: ['bob'] };
    const newer = { ...BUILD, id: 'newer-build', Id: 'newer-build', Scheduled: stamp(NOW - 1000), Owners: ['carol'] };
    render(<App />);
    snapshot(BUILD_TASKS, [], 0, [older, BUILD, newer]);
    const order = () => within(screen.getByRole('table', { name: 'Builds' })).getAllByRole('row')
        .map((row) => row.querySelector('td:nth-child(3)')?.textContent).filter(Boolean);

    // Newest first by default
    expect(order()).toEqual(['newer-build', 'build-012345', 'older-build']);
    const scheduled = screen.getByRole('columnheader', { name: /Scheduled/ });
    expect(scheduled).toHaveAttribute('aria-sort', 'descending');

    userEvent.click(screen.getByRole('button', { name: 'Owners' }));
    expect(order()).toEqual(['build-012345', 'older-build', 'newer-build']);
    userEvent.click(screen.getByRole('button', { name: 'Owners' }));
    expect(order()).toEqual(['newer-build', 'older-build', 'build-012345']);
    expect(screen.getByRole('columnheader', { name: /Owners/ })).toHaveAttribute('aria-sort', 'descending');

    // Only BUILD has tasks
    userEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(order()).toEqual(['newer-build', 'older-build', 'build-012345']);
});

test('builds are filtered by status and by searching their IDs, owners, origins and parameters', () => {
    const cancelled = { ...BUILD, id: 'cancelled', Id: 'cancelled', Status: 'BUILD_CANCELLED', Owners: ['bob'], Origin: '', Parameters: [] };
    const other = { ...BUILD, id: 'other-build', Id: 'other-build', Owners: ['carol'], Parameters: [{ Key: 'config.branch', Value: 'release' }] };
    render(<App />);
    snapshot(BUILD_TASKS, [], 0, [BUILD, cancelled, other]);
    const visible = () => within(screen.getByRole('table', { name: 'Builds' })).getAllByRole('row')
        .map((row) => row.querySelector('td:nth-child(3)')?.textContent).filter(Boolean).sort();
    expect(visible()).toEqual(['build-012345', 'cancelled', 'other-build']);

    const toolbar = screen.getByRole('toolbar', { name: 'Build controls' });
    userEvent.click(within(toolbar).getByRole('button', { name: 'Cancelled' }));
    expect(visible()).toEqual(['build-012345', 'other-build']);

    const search = screen.getByRole('textbox', { name: 'Search builds' });
    userEvent.type(search, 'branch=release');
    expect(visible()).toEqual(['other-build']);
    userEvent.clear(search);
    userEvent.type(search, 'CAROL');
    expect(visible()).toEqual(['other-build']);
    userEvent.clear(search);
    userEvent.type(search, 'bob');
    expect(within(screen.getByRole('table', { name: 'Builds' })).getByText('No matching builds')).toBeInTheDocument();
    userEvent.click(within(toolbar).getByRole('button', { name: 'Cancelled' }));
    expect(visible()).toEqual(['cancelled']);
});

test('builds are filtered by the text of their columns', () => {
    const other = { ...BUILD, id: 'other-build', Id: 'other-build', Owners: ['carol'], Origin: 'https://ci.example.com/build/8' };
    render(<App />);
    snapshot(BUILD_TASKS, [], 0, [BUILD, other]);
    // An open filter hides the rest of the page from assistive technology, like a dialog
    const table = () => screen.getByRole('table', { name: 'Builds', hidden: true });
    const visible = () => within(table()).getAllByRole('row', { hidden: true })
        .map((row) => row.querySelector('td:nth-child(3)')?.textContent).filter(Boolean).sort();

    // The tasks column filters by its summary
    userEvent.click(screen.getByRole('button', { name: 'Filter Tasks' }));
    userEvent.type(screen.getByRole('textbox', { name: 'Filter Tasks' }), 'running');
    expect(visible()).toEqual(['build-012345']);
    expect(screen.getByRole('button', { name: 'Filter Tasks', hidden: true })).toHaveAttribute('aria-pressed', 'true');
    userEvent.clear(screen.getByRole('textbox', { name: 'Filter Tasks' }));
    expect(visible()).toEqual(['build-012345', 'other-build']);
    userEvent.keyboard('{Escape}');
    // Let the popover finish closing
    act(() => { jest.advanceTimersByTime(1000); });

    // Filters on several columns combine
    userEvent.click(screen.getByRole('button', { name: 'Filter Origin' }));
    userEvent.type(screen.getByRole('textbox', { name: 'Filter Origin' }), 'build/8');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Filter Origin' }), { key: 'Enter' });
    // Let the popover finish closing
    act(() => { jest.advanceTimersByTime(1000); });
    expect(visible()).toEqual(['other-build']);
    userEvent.click(screen.getByRole('button', { name: 'Filter Owners' }));
    userEvent.type(screen.getByRole('textbox', { name: 'Filter Owners' }), 'alice');
    expect(within(table()).getByText('No matching builds')).toBeInTheDocument();
});

test('signing in is only offered when the dashboard is configured for it', async () => {
    render(<App />);
    snapshot();
    await act(async () => { await Promise.resolve(); });
    expect(auth.loadConfig).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
});
