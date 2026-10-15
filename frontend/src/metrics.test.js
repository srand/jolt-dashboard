import { formatDuration, hasWaitingTask, queueTimeMetrics } from './metrics';

const NOW = new Date('2026-10-15T12:00:00').getTime();

// The backend serialises timestamps as "2006-01-02 15:04:05" in local time.
function stamp(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function task(status, queuedSecondsAgo, startedSecondsAgo = null) {
    return {
        Status: status,
        Queued: stamp(NOW - queuedSecondsAgo * 1000),
        Started: startedSecondsAgo === null ? '' : stamp(NOW - startedSecondsAgo * 1000),
    };
}

test('an empty task list has no queue time', () => {
    expect(queueTimeMetrics([], NOW)).toEqual({ average: 0, median: 0, max: 0 });
});

test('a task that has not started yet is measured against the current time', () => {
    const tasks = [task('Queued', 30)];
    expect(queueTimeMetrics(tasks, NOW)).toEqual({ average: 30, median: 30, max: 30 });
    // Same tasks, later clock: the wait has grown.
    expect(queueTimeMetrics(tasks, NOW + 60000).max).toBe(90);
});

test('a started task is measured against its start time', () => {
    expect(queueTimeMetrics([task('Passed', 120, 110)], NOW).average).toBe(10);
});

test('the median of an even number of tasks is the mean of the middle two', () => {
    const tasks = [task('Passed', 50, 40), task('Passed', 70, 50), task('Passed', 90, 60), task('Passed', 120, 80)];
    // Waits: 10, 20, 30, 40.
    expect(queueTimeMetrics(tasks, NOW).median).toBe(25);
    expect(queueTimeMetrics(tasks, NOW).average).toBe(25);
});

test('the median of an odd number of tasks is the middle one', () => {
    const tasks = [task('Passed', 90, 60), task('Passed', 50, 40), task('Passed', 70, 50)];
    // Waits: 30, 10, 20 - unsorted on the way in.
    expect(queueTimeMetrics(tasks, NOW).median).toBe(20);
});

test('the maximum covers only tasks still in the queue', () => {
    // The longest wait belongs to a task that has already run, so it must not
    // be reported as the current queue's worst case.
    const tasks = [task('Passed', 600, 0), task('Queued', 30), task('Assigned', 45)];
    expect(queueTimeMetrics(tasks, NOW).max).toBe(45);
});

test('with nothing in the queue the maximum is zero rather than a past wait', () => {
    expect(queueTimeMetrics([task('Passed', 600, 0), task('Running', 90, 30)], NOW).max).toBe(0);
});

test('cancelled tasks are left out entirely', () => {
    const tasks = [task('Cancelled', 3600), task('Queued', 30)];
    expect(queueTimeMetrics(tasks, NOW)).toEqual({ average: 30, median: 30, max: 30 });
});

test('a task queued in the future counts as zero rather than negative', () => {
    // The scheduler's clock can run ahead of the browser's.
    expect(queueTimeMetrics([task('Queued', -60)], NOW)).toEqual({ average: 0, median: 0, max: 0 });
});

test('a waiting task is one whose metrics still depend on the clock', () => {
    expect(hasWaitingTask([task('Queued', 30)])).toBe(true);
    expect(hasWaitingTask([task('Assigned', 30)])).toBe(true);
});

test('a task list with nothing waiting does not depend on the clock', () => {
    expect(hasWaitingTask([])).toBe(false);
    expect(hasWaitingTask([task('Passed', 120, 110), task('Running', 90, 30)])).toBe(false);
    // Cancelled tasks never started, but they are not counted either.
    expect(hasWaitingTask([task('Cancelled', 3600)])).toBe(false);
});

test('durations are formatted at the precision the dashboard shows', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(30)).toBe('30s');
    expect(formatDuration(59.6)).toBe('60s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(213.33)).toBe('3m 33s');
    expect(formatDuration(600)).toBe('10m 0s');
    expect(formatDuration(3600)).toBe('1h 0m');
    expect(formatDuration(5400)).toBe('1h 30m');
    // 1h 59m 59.6s rounds up through the minute and into the next hour.
    expect(formatDuration(7199.6)).toBe('2h 0m');
});
