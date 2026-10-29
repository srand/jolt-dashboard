import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

import TaskLog from './TaskLog';

// jsdom does not define these, so borrow node's, same as logStream.test.js.
// TaskLog's streaming path goes through createLogDecoder, which reads the
// global when it is called, not at import time, so assigning it here is in
// time.
global.TextDecoder = global.TextDecoder || NodeTextDecoder;
global.TextEncoder = global.TextEncoder || NodeTextEncoder;

// A reader whose first read() is controlled by the test, and whose every
// subsequent read() just hangs. Good enough for "something arrived" without
// needing a real streaming body.
function pendingReader() {
    let resolveFirst;
    const firstRead = new Promise((resolve) => { resolveFirst = resolve; });
    let calls = 0;

    return {
        read: jest.fn(() => {
            calls += 1;
            if (calls === 1) {
                return firstRead;
            }
            return new Promise(() => {}); // never resolves
        }),
        resolveFirst: (result) => resolveFirst(result),
    };
}

// A reader backed by a FIFO queue of read() results. Unlike pendingReader,
// read() can be called (and resolved) more than once, so a test can drive a
// stream through several chunks. push() resolves the oldest outstanding
// read() if pump() is already waiting on one, or queues the result for the
// next read() otherwise.
function queueReader() {
    const queued = [];
    const waiting = [];

    return {
        push: (result) => {
            if (waiting.length > 0) {
                waiting.shift()(result);
            } else {
                queued.push(result);
            }
        },
        read: jest.fn(() => {
            if (queued.length > 0) {
                return Promise.resolve(queued.shift());
            }
            return new Promise((resolve) => { waiting.push(resolve); });
        }),
    };
}

function okResponse(reader) {
    return Promise.resolve({ ok: true, status: 200, body: { getReader: () => reader } });
}

function notFoundResponse() {
    return Promise.resolve({ ok: false, status: 404 });
}

// A reader whose first read() resolves with real data, and whose second
// read() rejects - standing in for a connection dropping partway through an
// otherwise-working stream.
function readThenFailReader(firstChunk) {
    let calls = 0;
    return {
        read: jest.fn(() => {
            calls += 1;
            if (calls === 1) {
                return Promise.resolve({ done: false, value: firstChunk });
            }
            return Promise.reject(new Error('stream dropped'));
        }),
    };
}

// A non-ok, non-404 response (e.g. a 500 from logstash). `body` is a getter
// so the test can prove the handler never even tried to read it - item 2's
// finding is specifically that the error body must not be streamed into the
// log, not just that the same error message happens to come out either way.
function errorResponse(status) {
    const access = { bodyRead: false };
    const response = {
        ok: false,
        status,
        get body() {
            access.bodyRead = true;
            return { getReader: () => pendingReader() };
        },
    };
    return { promise: Promise.resolve(response), access };
}

afterEach(() => {
    delete global.fetch;
    jest.useRealTimers();
    jest.clearAllMocks();
});

test('task details show full attribution and update it with build metadata', () => {
    const value = 'https://ci.example.com/build/' + 'long-path/'.repeat(20);
    const task = { id: 'details-1', Status: 'Passed', Name: 'Build', Build: { Origin: value } };
    const { rerender } = render(<TaskLog open={true} task={task} onClose={() => {}} />);

    expect(screen.getByText('Origin')).toBeInTheDocument();
    expect(screen.queryByText('Username')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: value })).toHaveAttribute('href', value);
    expect(screen.getByTitle(value)).not.toHaveStyle({ textOverflow: 'ellipsis' });

    rerender(<TaskLog open={true} task={{ ...task, Build: { Origin: 'builder@example.com' } }} onClose={() => {}} />);
    expect(screen.getByText('builder@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: value })).not.toBeInTheDocument();

    rerender(<TaskLog open={true} task={{ ...task, Build: null }} onClose={() => {}} />);
    expect(screen.getByRole('region', { name: 'Build attribution' }).textContent).toBe('Origin');
});

test.each([
    { name: 'long URL', origin: 'https://ci.example.com/build/' + 'long-path/'.repeat(300) },
    { name: 'multiline origin', origin: Array.from({ length: 50 }, (_, i) => 'origin line ' + i).join('\n') },
])('$name uses a keyboard-scrollable horizontal region rather than wrapping', ({ origin }) => {
    const task = { id: 'long-attribution', Status: 'Passed', Name: 'Build', Build: { Origin: origin } };
    render(<TaskLog open={true} task={task} onClose={() => {}} />);

    const region = screen.getByRole('region', { name: 'Build attribution' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveStyle({ minWidth: '0', flexShrink: '0', overflowX: 'auto' });
    const value = screen.getByTitle(origin, { normalizer: (text) => text });
    expect(region).toContainElement(value);
    expect(value.textContent).toBe(origin);
    expect(value).toHaveStyle({ whiteSpace: 'nowrap' });
    expect(value).not.toHaveStyle({ textOverflow: 'ellipsis' });
});

test('a running task is fetched with follow=1', async () => {
    global.fetch = jest.fn(() => okResponse(pendingReader()));
    const task = { id: 'run-1', Status: 'Running', Name: 'Build' };

    const { rerender } = render(<TaskLog open={false} task={task} onClose={() => {}} />);
    rerender(<TaskLog open={true} task={task} onClose={() => {}} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/tasks/run-1/log?follow=1');
});

test('a terminal task is fetched without a query string', async () => {
    global.fetch = jest.fn(() => okResponse(pendingReader()));
    const task = { id: 'done-1', Status: 'Passed', Name: 'Build' };

    const { rerender } = render(<TaskLog open={false} task={task} onClose={() => {}} />);
    rerender(<TaskLog open={true} task={task} onClose={() => {}} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/tasks/done-1/log');
});

test('a 404 is retried after 2 seconds while the task is still running', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(() => notFoundResponse());
    const task = { id: 'run-2', Status: 'Running' };

    const { rerender } = render(<TaskLog open={false} task={task} onClose={() => {}} />);
    rerender(<TaskLog open={true} task={task} onClose={() => {}} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), { timeout: 3000 });

    expect(fetch.mock.calls[1][0]).toBe(fetch.mock.calls[0][0]);
});

test('a 404 for a terminal task is not retried, and shows the empty state instead of the spinner', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(() => notFoundResponse());
    const task = { id: 'done-2', Status: 'Passed' };

    const { rerender } = render(<TaskLog open={false} task={task} onClose={() => {}} />);
    rerender(<TaskLog open={true} task={task} onClose={() => {}} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('No log output.')).toBeInTheDocument());

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

    act(() => { jest.advanceTimersByTime(5000); });
    expect(fetch).toHaveBeenCalledTimes(1);
});

test('closing the dialog aborts the in-flight fetch and cancels a pending retry', async () => {
    jest.useFakeTimers();
    let signal;
    global.fetch = jest.fn((url, opts) => {
        signal = opts.signal;
        return notFoundResponse();
    });
    const task = { id: 'run-3', Status: 'Running' };

    const { rerender } = render(<TaskLog open={false} task={task} onClose={() => {}} />);
    rerender(<TaskLog open={true} task={task} onClose={() => {}} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(signal.aborted).toBe(false);

    // Close before the scheduled retry fires.
    rerender(<TaskLog open={false} task={task} onClose={() => {}} />);
    expect(signal.aborted).toBe(true);

    act(() => { jest.advanceTimersByTime(5000); });
    expect(fetch).toHaveBeenCalledTimes(1);
});

test('unmounting aborts the in-flight fetch and cancels a pending retry', async () => {
    jest.useFakeTimers();
    let signal;
    global.fetch = jest.fn((url, opts) => {
        signal = opts.signal;
        return notFoundResponse();
    });
    const task = { id: 'run-4', Status: 'Running' };

    const { rerender, unmount } = render(<TaskLog open={false} task={task} onClose={() => {}} />);
    rerender(<TaskLog open={true} task={task} onClose={() => {}} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);

    act(() => { jest.advanceTimersByTime(5000); });
    expect(fetch).toHaveBeenCalledTimes(1);
});

test('a chunk that arrives after the component moved on to a different task is dropped', async () => {
    const readerA = pendingReader();
    let urlForB;
    global.fetch = jest.fn((url) => {
        if (url.startsWith('/api/v1/tasks/task-a/')) {
            return okResponse(readerA);
        }
        urlForB = url;
        return okResponse(pendingReader());
    });

    const taskA = { id: 'task-a', Status: 'Running' };
    const taskB = { id: 'task-b', Status: 'Running' };

    const { rerender } = render(<TaskLog open={false} task={taskA} onClose={() => {}} />);
    rerender(<TaskLog open={true} task={taskA} onClose={() => {}} />);

    // Wait until the component is actually inside the read loop for task A.
    await waitFor(() => expect(readerA.read).toHaveBeenCalledTimes(1));

    // The dialog stays open, but now shows a different task - this is the
    // scenario item 2 exists for, and it is also how a stream this
    // component "moved on from" comes about.
    rerender(<TaskLog open={true} task={taskB} onClose={() => {}} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(urlForB).toBe('/api/v1/tasks/task-b/log?follow=1');

    // Task A's chunk resolves only now, after the switch.
    await act(async () => {
        readerA.resolveFirst({ done: false, value: new TextEncoder().encode('leaked-content\n') });
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText('leaked-content')).not.toBeInTheDocument();
    // Task B's own fetch never resolves in this test, so it is still loading.
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
});

// The only other test that resolves a reader with real bytes asserts that
// content is *absent* (the staleness guard, above). Nothing here proved that
// a chunk which should render actually does. This drives two chunks for the
// one current task, split across the line boundary, and checks both that the
// joined line appears and that the partial half is never shown on its own -
// the thing createLogDecoder's internal buffering exists to guarantee, now
// exercised end to end through TaskLog itself rather than through logStream
// in isolation.
test('a line split across two chunks renders once joined, never as a bare partial', async () => {
    jest.useFakeTimers();
    const reader = queueReader();
    global.fetch = jest.fn(() => okResponse(reader));
    const task = { id: 'run-5', Status: 'Running' };

    const { rerender } = render(<TaskLog open={false} task={task} onClose={() => {}} />);
    rerender(<TaskLog open={true} task={task} onClose={() => {}} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await act(async () => {
        reader.push({ done: false, value: new TextEncoder().encode('a\nb') });
        // Let the microtask chain inside pump()/append() run; fake timers
        // only fake timer callbacks, not the native Promise microtask queue.
        await Promise.resolve();
        await Promise.resolve();
    });
    // Let the batched flush (item 1) land.
    act(() => { jest.advanceTimersByTime(1000); });

    // MUI's Dialog portals its content onto document.body rather than into
    // the render()'d container, so query the document, same as `screen`.
    let lines = document.querySelector('pre').textContent.split('\n');
    expect(lines).toContain('a');
    expect(lines).not.toContain('b');
    expect(lines).not.toContain('bc');

    await act(async () => {
        reader.push({ done: false, value: new TextEncoder().encode('c\n') });
        await Promise.resolve();
        await Promise.resolve();
    });
    act(() => { jest.advanceTimersByTime(1000); });

    lines = document.querySelector('pre').textContent.split('\n');
    expect(lines).toContain('bc');
    expect(lines).not.toContain('b');
});

test('a non-terminal task whose stream ends empty says it is waiting, not that it produced nothing', async () => {
    const reader = pendingReader();
    global.fetch = jest.fn(() => okResponse(reader));
    const task = { id: 'run-7', Status: 'Running' };

    const { rerender } = render(<TaskLog open={false} task={task} onClose={() => {}} />);
    rerender(<TaskLog open={true} task={task} onClose={() => {}} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    // The stream ends cleanly with zero bytes while the task is still
    // running - a dropped connection, not a 404. Reconnecting is out of
    // scope; the only fix here is not to claim the task produced nothing.
    await act(async () => {
        reader.resolveFirst({ done: true, value: undefined });
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByText('Waiting for output…')).toBeInTheDocument();
    expect(screen.queryByText('No log output.')).not.toBeInTheDocument();
});

test('a stream that fails after content has arrived keeps the content and shows an error banner', async () => {
    const reader = readThenFailReader(new TextEncoder().encode('line one\n'));
    global.fetch = jest.fn(() => okResponse(reader));
    const task = { id: 'run-8', Status: 'Running' };

    const { rerender } = render(<TaskLog open={false} task={task} onClose={() => {}} />);
    rerender(<TaskLog open={true} task={task} onClose={() => {}} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await screen.findByText('Error loading log.');

    // The error must be a banner alongside the content, not a replacement
    // for it - the lines already received are still worth having on screen.
    expect(document.querySelector('pre').textContent).toContain('line one');
});

test('the 404 retry gives up once its budget elapses, even though the task never turns terminal', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);

    global.fetch = jest.fn(() => notFoundResponse());
    // Stands in for App.js's scenario: the task was deleted and dropped from
    // the row list, so TaskLog is stuck looking at a stale non-terminal
    // snapshot that will never update to a terminal status on its own.
    const task = { id: 'run-9', Status: 'Running' };

    const { rerender } = render(<TaskLog open={false} task={task} onClose={() => {}} />);
    rerender(<TaskLog open={true} task={task} onClose={() => {}} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), { timeout: 3000 });

    // Jump straight to just past the 5-minute retry budget fetchLog set when
    // the stream started, then let the already-scheduled retry's 404
    // handler see that the deadline has passed.
    jest.setSystemTime(6 * 60 * 1000);
    act(() => { jest.advanceTimersByTime(2000); });

    await screen.findByText('Waiting for output…');

    // No further retry once the budget is exhausted.
    const callsAtBudget = fetch.mock.calls.length;
    act(() => { jest.advanceTimersByTime(10000); });
    expect(fetch.mock.calls.length).toBe(callsAtBudget);
});

test('a non-ok, non-404 response shows the error state and never reads the body', async () => {
    const { promise, access } = errorResponse(500);
    global.fetch = jest.fn(() => promise);
    const task = { id: 'run-6', Status: 'Running' };

    const { rerender } = render(<TaskLog open={false} task={task} onClose={() => {}} />);
    rerender(<TaskLog open={true} task={task} onClose={() => {}} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await screen.findByText('Error loading log.');

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(access.bodyRead).toBe(false);
});
