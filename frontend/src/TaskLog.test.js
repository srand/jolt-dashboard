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

function okResponse(reader) {
    return Promise.resolve({ ok: true, status: 200, body: { getReader: () => reader } });
}

function notFoundResponse() {
    return Promise.resolve({ ok: false, status: 404 });
}

afterEach(() => {
    delete global.fetch;
    jest.useRealTimers();
    jest.clearAllMocks();
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
