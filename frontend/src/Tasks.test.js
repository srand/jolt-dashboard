import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';

import Tasks from './Tasks';

global.TextDecoder = global.TextDecoder || NodeTextDecoder;
global.TextEncoder = global.TextEncoder || NodeTextEncoder;

const COLUMN_VISIBILITY_STORAGE_KEY = 'jolt-dashboard.tasks.columnVisibility.v1';

beforeEach(() => {
    window.localStorage.removeItem(COLUMN_VISIBILITY_STORAGE_KEY);
});

afterEach(() => {
    jest.restoreAllMocks();
    window.localStorage.removeItem(COLUMN_VISIBILITY_STORAGE_KEY);
    delete global.fetch;
    jest.useRealTimers();
});

test('hidden columns from the chooser are remembered after remounting', async () => {
    const { unmount } = render(<Tasks value={[]} />);
    userEvent.click(screen.getByRole('button', { name: 'Show columns' }));
    userEvent.click(await screen.findByRole('checkbox', { name: 'Origin' }));
    expect(screen.queryByRole('columnheader', { name: 'Origin' })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(COLUMN_VISIBILITY_STORAGE_KEY))).toMatchObject({ Origin: false });
    unmount();

    const { unmount: unmountRestored } = render(<Tasks value={[]} />);
    expect(screen.queryByRole('columnheader', { name: 'Origin' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    userEvent.click(screen.getByRole('button', { name: 'Show columns' }));
    const originToggle = await screen.findByRole('checkbox', { name: 'Origin' });
    expect(originToggle).not.toBeChecked();
    userEvent.click(originToggle);
    expect(screen.getByRole('columnheader', { name: 'Origin' })).toBeInTheDocument();
    unmountRestored();

    render(<Tasks value={[]} />);
    expect(screen.getByRole('columnheader', { name: 'Origin' })).toBeInTheDocument();
});

test('Hide all and Show all column choices are remembered', async () => {
    const { unmount } = render(<Tasks value={[]} />);
    userEvent.click(screen.getByRole('button', { name: 'Show columns' }));
    userEvent.click(await screen.findByRole('button', { name: 'Hide all' }));
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
    unmount();

    const { unmount: unmountRestored } = render(<Tasks value={[]} />);
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
    userEvent.click(screen.getByRole('button', { name: 'Show columns' }));
    userEvent.click(await screen.findByRole('button', { name: 'Show all' }));
    expect(screen.getAllByRole('columnheader')).toHaveLength(12);
    unmountRestored();

    render(<Tasks value={[]} />);
    expect(screen.getAllByRole('columnheader')).toHaveLength(12);
});

test.each(['{invalid', 'null', '[]', 'false'])('invalid saved visibility %s falls back to visible columns', (saved) => {
    window.localStorage.setItem(COLUMN_VISIBILITY_STORAGE_KEY, saved);
    render(<Tasks value={[]} />);
    expect(screen.getAllByRole('columnheader')).toHaveLength(12);
});

test('saved visibility ignores removed columns and non-boolean values', async () => {
    window.localStorage.setItem(COLUMN_VISIBILITY_STORAGE_KEY, JSON.stringify({
        Origin: false, Name: null, RemovedColumn: false,
    }));
    render(<Tasks value={[]} />);
    expect(screen.queryByRole('columnheader', { name: 'Origin' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(11);
    userEvent.click(screen.getByRole('button', { name: 'Show columns' }));
    userEvent.click(await screen.findByRole('checkbox', { name: 'Origin' }));
    expect(JSON.parse(window.localStorage.getItem(COLUMN_VISIBILITY_STORAGE_KEY))).toEqual({ Origin: true });
});

test.each(['getItem', 'setItem'])('column visibility still works if storage %s fails', async (method) => {
    const storage = jest.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error('Storage unavailable');
    });
    render(<Tasks value={[]} />);
    expect(screen.getAllByRole('columnheader')).toHaveLength(12);
    userEvent.click(screen.getByRole('button', { name: 'Show columns' }));
    const originToggle = await screen.findByRole('checkbox', { name: 'Origin' });
    userEvent.click(originToggle);
    expect(screen.queryByRole('columnheader', { name: 'Origin' })).not.toBeInTheDocument();
    userEvent.click(originToggle);
    expect(screen.getByRole('columnheader', { name: 'Origin' })).toBeInTheDocument();
    expect(storage).toHaveBeenCalled();
});

test('the top-level column chooser hides and restores columns across task updates', async () => {
    const task = { id: 'task-columns', Name: 'Build', Status: 'Queued', Build: { Origin: 'origin' } };
    const { rerender } = render(<Tasks value={[task]} updating />);
    const toolbar = screen.getByRole('toolbar', { name: 'Task controls' });
    const columnsButton = screen.getByRole('button', { name: 'Show columns' });
    expect(columnsButton).toHaveTextContent('Columns');
    expect(within(toolbar).getByRole('button', { name: 'Queued' })).toBeInTheDocument();

    userEvent.click(columnsButton);
    const originToggle = await screen.findByRole('checkbox', { name: 'Origin' });
    expect(originToggle).toBeChecked();
    userEvent.click(originToggle);
    expect(screen.queryByRole('columnheader', { name: 'Origin' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();

    rerender(<Tasks value={[{ ...task, Build: { Origin: 'new origin' } }]} updating />);
    expect(screen.queryByRole('columnheader', { name: 'Origin' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Origin' })).not.toBeChecked();
    userEvent.click(screen.getByRole('checkbox', { name: 'Origin' }));
    expect(screen.getByRole('columnheader', { name: 'Origin' })).toBeInTheDocument();
    expect(screen.getByText('new origin')).toBeInTheDocument();
});

test('task controls render above and outside the bordered grid', () => {
    render(<Tasks value={[]} updating />);
    const toolbar = screen.getByRole('toolbar', { name: 'Task controls' });
    const grid = screen.getByRole('table', { name: 'Tasks' });
    expect(grid).not.toContainElement(toolbar);
    expect(toolbar.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const columnsButton = screen.getByRole('button', { name: 'Show columns' });
    expect(grid).not.toContainElement(columnsButton);
    expect(columnsButton.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(toolbar).getAllByRole('button')).toHaveLength(8);
    // The columns button is left of the status filters
    const buttons = within(toolbar).getAllByRole('button');
    expect(buttons.indexOf(columnsButton)).toBe(buttons.indexOf(within(toolbar).getByRole('button', { name: 'Queued' })) - 1);
});

test('external task controls still pause, resume, and filter', () => {
    const onPause = jest.fn();
    const onPlay = jest.fn();
    const task = { id: 'task-controls', Name: 'Build', Status: 'Queued' };
    const { rerender } = render(<Tasks value={[task]} updating onPause={onPause} onPlay={onPlay} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Task controls' });
    // The existing pause/play control is icon-only, with no accessible name.
    userEvent.click(within(toolbar).getByRole('button', { name: '' }));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onPlay).not.toHaveBeenCalled();
    userEvent.click(within(toolbar).getByRole('button', { name: 'Queued' }));
    expect(screen.queryByRole('button', { name: 'View details and log for Build' })).not.toBeInTheDocument();
    userEvent.click(within(toolbar).getByRole('button', { name: 'Queued' }));
    expect(screen.getByRole('button', { name: 'View details and log for Build' })).toBeInTheDocument();

    rerender(<Tasks value={[task]} updating={false} onPause={onPause} onPlay={onPlay} />);
    userEvent.click(within(toolbar).getByRole('button', { name: '' }));
    expect(onPlay).toHaveBeenCalledTimes(1);
});

test('the task list has a compact origin column with full text available, and no user column', () => {
    const value = 'https://ci.example.com/build/' + 'long-path/'.repeat(20);
    const task = { id: 'task-1', Name: 'Build', Status: 'Queued', Log: '', Build: { Origin: value, Owners: ['alice'] } };
    const { rerender } = render(<Tasks value={[task]} />);

    expect(screen.getByRole('columnheader', { name: 'Origin' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Username' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Owners' })).not.toBeInTheDocument();
    expect(screen.queryByText('alice')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: value })).toHaveAttribute('href', value);
    expect(screen.getByTitle(value)).toHaveStyle({ textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

    rerender(<Tasks value={[{ ...task, Build: null }]} />);
    const grid = screen.getByRole('table', { name: 'Tasks' });
    for (const field of ['Origin']) {
        const cell = within(grid).getAllByRole('cell').find((cell) => cell.getAttribute('data-field') === field);
        expect(cell).toBeInTheDocument();
        expect(cell.textContent).toBe('');
    }
    expect(screen.queryByRole('link', { name: value })).not.toBeInTheDocument();
});

test.each(['Queued', 'Assigned', 'Cancelled'])('a %s task with no log can open details showing full attribution', async (status) => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404 }));
    const value = 'https://ci.example.com/build/' + 'long-path/'.repeat(20);
    const task = { id: 'task-no-log', Name: 'Build', Status: status, Log: '', Build: { Origin: value } };
    const { rerender } = render(<Tasks value={[task]} />);

    const action = screen.getByRole('button', { name: 'View details and log for Build' });
    expect(action).toBeEnabled();
    userEvent.click(action);

    const dialog = await screen.findByRole('dialog', { name: 'Build' });
    expect(within(dialog).getByText('Origin')).toBeInTheDocument();
    expect(within(dialog).queryByText('Username')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: value })).toHaveAttribute('href', value);
    const field = within(dialog).getByTitle(value);
    expect(field.textContent).toBe(value);
    expect(field).toHaveStyle({ whiteSpace: 'nowrap' });
    expect(field).not.toHaveStyle({ textOverflow: 'ellipsis' });
    const region = within(dialog).getByRole('region', { name: 'Build attribution' });
    expect(region).toContainElement(field);
    expect(region).toHaveStyle({ overflowX: 'auto' });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
        '/api/v1/tasks/task-no-log/log' + (status === 'Cancelled' ? '' : '?follow=1'),
        expect.objectContaining({ signal: expect.anything() }),
    ));
    rerender(<Tasks value={[{ ...task, Build: { Origin: 'updated origin' } }]} />);
    expect(within(dialog).getByText('updated origin')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: value })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
});

test('clicking a task origin link does not open its details dialog', () => {
    global.fetch = jest.fn();
    const value = 'https://ci.example.com/build/123';
    const task = { id: 'task-link', Name: 'Build', Status: 'Queued', Log: '', Build: { Origin: value } };
    render(<Tasks value={[task]} />);

    userEvent.click(screen.getByRole('link', { name: value }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
});

test('a removed task keeps its last observed details and loaded log without restarting fetching', async () => {
    const reader = { read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('retained log output\n') })
        .mockResolvedValue({ done: true }) };
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, body: { getReader: () => reader } }));
    const initial = {
        id: 'removed-task', Name: 'Build', Status: 'Passed', Log: 'log-url',
        Started: '2026-10-27 10:00:00', Ended: '2026-10-27 10:01:00',
        Build: { Origin: 'opening origin' },
    };
    const updated = {
        ...initial, Status: 'Failed', Started: '2026-10-27 11:00:00', Ended: '2026-10-27 11:01:00',
        Build: { Origin: 'latest origin' },
    };
    const { rerender } = render(<Tasks value={[initial]} />);
    userEvent.click(screen.getByRole('button', { name: 'View details and log for Build' }));
    const dialog = await screen.findByRole('dialog', { name: 'Build' });
    await waitFor(() => expect(within(dialog).getByText('retained log output')).toBeInTheDocument());
    const signal = fetch.mock.calls[0][1].signal;

    rerender(<Tasks value={[updated]} />);
    rerender(<Tasks value={[]} />);

    expect(within(dialog).getByText('latest origin')).toBeInTheDocument();
    expect(within(dialog).getByText('Failed')).toBeInTheDocument();
    expect(within(dialog).getByText(updated.Started)).toBeInTheDocument();
    expect(within(dialog).getByText(updated.Ended)).toBeInTheDocument();
    expect(within(dialog).queryByText('opening origin')).not.toBeInTheDocument();
    expect(within(dialog).getByText('retained log output')).toBeInTheDocument();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Task is no longer in the current list');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Build' })).toBe(dialog);
});

test('removal during pending log streaming preserves buffered chunks and accepts later chunks', async () => {
    jest.useFakeTimers();
    let deliver;
    const reader = { read: jest.fn(() => new Promise((resolve) => { deliver = resolve; })) };
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, body: { getReader: () => reader } }));
    const initial = {
        id: 'streaming-task', Name: 'Build', Status: 'Running',
        Build: { Origin: 'opening origin' },
    };
    const { rerender } = render(<Tasks value={[initial]} />);
    userEvent.click(screen.getByRole('button', { name: 'View details and log for Build' }));
    await act(async () => { await Promise.resolve(); });
    const dialog = screen.getByRole('dialog', { name: 'Build' });
    const signal = fetch.mock.calls[0][1].signal;
    expect(reader.read).toHaveBeenCalledTimes(1);

    await act(async () => {
        deliver({ done: false, value: new TextEncoder().encode('before removal one\n') });
    });
    await act(async () => {
        deliver({ done: false, value: new TextEncoder().encode('before removal two\n') });
    });
    // Both chunks are buffered behind the flush timer while the next read hangs.
    expect(reader.read).toHaveBeenCalledTimes(3);
    expect(within(dialog).queryByText('before removal one')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('before removal two')).not.toBeInTheDocument();
    rerender(<Tasks value={[{ ...initial, Build: { Origin: 'latest origin' } }]} />);
    rerender(<Tasks value={[]} />);
    expect(within(dialog).getByRole('status')).toBeInTheDocument();
    expect(within(dialog).getByText('latest origin')).toBeInTheDocument();
    expect(within(dialog).getByText('Running')).toBeInTheDocument();
    expect(within(dialog).queryByText('Deleted')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);

    act(() => { jest.advanceTimersByTime(150); });
    expect(within(dialog).getByText('before removal one\nbefore removal two\n', {
        normalizer: (text) => text,
    })).toBeInTheDocument();
    await act(async () => {
        deliver({ done: false, value: new TextEncoder().encode('after removal\n') });
    });
    act(() => { jest.advanceTimersByTime(150); });
    expect(within(dialog).getByText('before removal one\nbefore removal two\nafter removal\n', {
        normalizer: (text) => text,
    })).toBeInTheDocument();
    expect(reader.read).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/tasks/streaming-task/log?follow=1');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Build' })).toBe(dialog);
});

test.each([null, { Origin: '' }])('cleared attribution is retained after removal: %s', async (build) => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404 }));
    const initial = { id: 'cleared-task', Name: 'Build', Status: 'Passed', Build: { Origin: 'opening origin' } };
    const { rerender } = render(<Tasks value={[initial]} />);
    userEvent.click(screen.getByRole('button', { name: 'View details and log for Build' }));
    await screen.findByText('No log output.');
    rerender(<Tasks value={[{ ...initial, Build: build }]} />);
    rerender(<Tasks value={[]} />);
    const dialog = screen.getByRole('dialog', { name: 'Build' });
    expect(within(dialog).getByRole('region', { name: 'Build attribution' }).textContent).toBe('Origin');
    expect(within(dialog).queryByText('opening origin')).not.toBeInTheDocument();
});

test('filtering does not mark the open task removed, and a returning row updates it again', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404 }));
    const initial = { id: 'filtered-task', Name: 'Build', Status: 'Passed', Build: { Origin: 'original origin' } };
    const tasks = React.createRef();
    const { rerender } = render(<Tasks ref={tasks} value={[initial]} />);
    userEvent.click(screen.getByRole('button', { name: 'View details and log for Build' }));
    await screen.findByText('No log output.');
    const dialog = screen.getByRole('dialog', { name: 'Build' });
    // Hide passed tasks
    userEvent.click(screen.getByRole('button', { name: 'Passed', hidden: true }));
    const updated = { ...initial, Build: { Origin: 'filtered update' } };
    rerender(<Tasks ref={tasks} value={[updated]} />);
    expect(within(dialog).getByText('filtered update')).toBeInTheDocument();
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Tasks', hidden: true })).queryByRole('button', { name: 'View details and log for Build', hidden: true })).not.toBeInTheDocument();
    rerender(<Tasks ref={tasks} value={[]} />);
    expect(within(dialog).getByText('filtered update')).toBeInTheDocument();
    expect(within(dialog).getByRole('status')).toBeInTheDocument();
    rerender(<Tasks ref={tasks} value={[{ ...updated, Build: { Origin: 'returned origin' } }]} />);
    expect(within(dialog).getByText('returned origin')).toBeInTheDocument();
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
});

test('opening a different task starts a new last-observed fallback', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404 }));
    const first = { id: 'first-task', Name: 'First', Status: 'Passed', Build: { Origin: 'first origin' } };
    const second = { id: 'second-task', Name: 'Second', Status: 'Passed', Build: { Origin: 'second origin' } };
    const { rerender } = render(<Tasks value={[first, second]} />);
    userEvent.click(screen.getByRole('button', { name: 'View details and log for First' }));
    await screen.findByText('No log output.');
    rerender(<Tasks value={[second]} />);
    userEvent.click(screen.getByRole('button', { name: 'Close task details' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    userEvent.click(screen.getByRole('button', { name: 'View details and log for Second' }));
    await screen.findByText('No log output.');
    rerender(<Tasks value={[]} />);
    const dialog = screen.getByRole('dialog', { name: 'Second' });
    expect(within(dialog).getByText('second origin')).toBeInTheDocument();
    expect(within(dialog).queryByText('first origin')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('status')).toBeInTheDocument();
});

test('tasks are found by searching and filtered by the text of their columns', async () => {
    const tasks = [
        { id: 'compile', Name: 'Compile', Identity: 'abc', Worker: 'worker-1', Status: 'Passed', BuildId: 'build-1', Build: { Origin: 'https://ci.example.com/1' } },
        { id: 'link', Name: 'Link', Identity: 'def', Worker: 'worker-2', Status: 'Running', BuildId: 'build-2' },
    ];
    render(<Tasks value={tasks} />);
    const names = () => screen.queryAllByRole('cell').filter((cell) => cell.getAttribute('data-field') === 'Name')
        .map((cell) => cell.textContent).sort();
    expect(names()).toEqual(['Compile', 'Link']);

    const search = screen.getByRole('textbox', { name: 'Search tasks' });
    userEvent.type(search, 'ci.example');
    expect(names()).toEqual(['Compile']);
    userEvent.clear(search);
    userEvent.type(search, 'build-2');
    expect(names()).toEqual(['Link']);
    userEvent.clear(search);

    userEvent.click(screen.getByRole('button', { name: 'Filter Worker' }));
    userEvent.type(await screen.findByRole('textbox', { name: 'Filter Worker' }), '-1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Filter Worker', hidden: true })).toHaveAttribute('aria-pressed', 'true'));
    userEvent.keyboard('{Escape}');
    await waitFor(() => expect(names()).toEqual(['Compile']));
});
