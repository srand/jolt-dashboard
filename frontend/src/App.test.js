import React from 'react';
import { act, render, screen } from '@testing-library/react';

import App from './App';

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

    close() { }
}

function mockFetch(tasks) {
    return jest.fn((url) => {
        const body = url === '/api/v1/tasks' ? tasks : [];
        return Promise.resolve({ json: () => Promise.resolve(body) });
    });
}

// Let the fetch -> json -> setState promise chain run to completion without
// advancing any timer - the point of these tests is what is on screen before
// a timer fires.
async function settle() {
    await act(async () => {
        for (let i = 0; i < 10; i += 1) {
            await Promise.resolve();
        }
    });
}

function metric(name) {
    return screen.getByText(name).parentElement.querySelector('h2').textContent;
}

beforeEach(() => {
    FakeWebSocket.instances = [];
    global.WebSocket = FakeWebSocket;
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

test('queue time metrics are right as soon as the first task list arrives', async () => {
    global.fetch = mockFetch(TASKS);

    render(<App />);
    await settle();

    // The task rows are already on screen at this point, so the queue times
    // derived from them must be too.
    expect(metric('Queue Time (1h avg)')).toBe('20s');
    expect(metric('Queue Time (1h med)')).toBe('20s');
    expect(metric('Queue Time (qmax)')).toBe('30s');
});

test('a task arriving over the websocket updates queue time without waiting for a poll', async () => {
    global.fetch = mockFetch(TASKS);

    render(<App />);
    await settle();

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe('ws://localhost/api/v1/tasks/events');

    // A task that has been queued for ten minutes shows up.
    await act(async () => {
        socket.onmessage({ data: JSON.stringify(task('queued-2', 'Queued', 600000, null)) });
        await Promise.resolve();
    });

    expect(metric('In Queue')).toBe('2');
    expect(metric('Queue Time (qmax)')).toBe('10m 0s');
    expect(metric('Queue Time (1h avg)')).toBe('3m 33s');
});

test('queue time keeps counting up while a task sits in the queue', async () => {
    global.fetch = mockFetch(TASKS);

    render(<App />);
    await settle();

    // Nothing changes but the wall clock, which fake timers advance along
    // with the timers: the task queued 30s ago has now been waiting 90s, so
    // the metrics have to move with it.
    act(() => { jest.advanceTimersByTime(60000); });

    expect(metric('Queue Time (qmax)')).toBe('1m 30s');
});

test('the metrics timer is stopped when the dashboard unmounts', async () => {
    global.fetch = mockFetch(TASKS);

    const { unmount } = render(<App />);
    await settle();

    unmount();
    expect(jest.getTimerCount()).toBe(0);
});
