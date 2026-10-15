// Queue time metrics, derived from the task list rather than accumulated.
//
// A task's queue time is the wait between being queued and being started, and
// for a task that has not started yet it keeps growing with the wall clock.
// That makes `now` an input, so these are plain functions of (tasks, now) and
// the caller decides when to recompute.

// Statuses that contribute to the metrics. Cancelled tasks are excluded: they
// never started, so their wait is unbounded and says nothing about the queue.
const COUNTED = ['Queued', 'Assigned', 'Running', 'Passed', 'Failed'];

// Statuses of tasks still waiting for a worker. Only these count towards the
// queue time maximum, which is about the current queue, not past tasks.
const WAITING = ['Queued', 'Assigned'];

function counted(tasks) {
    return tasks.filter((task) => COUNTED.includes(task.Status));
}

// Seconds a task has spent waiting, as of `now`.
function queueSeconds(task, now) {
    const queued = new Date(task.Queued).getTime();
    const started = task.Started === '' ? now : new Date(task.Started).getTime();
    const seconds = (started - queued) / 1000;
    // The scheduler's clock and the browser's can disagree.
    return seconds > 0 ? seconds : 0;
}

// Whether any task's queue time still depends on the current time. When
// nothing is waiting, the metrics only change when the task list does, so
// there is no reason to recompute them on a timer.
export function hasWaitingTask(tasks) {
    return counted(tasks).some((task) => task.Started === '');
}

// Average, median and maximum queue time in seconds. The maximum covers only
// tasks still in the queue; the average and median cover every counted task.
export function queueTimeMetrics(tasks, now) {
    const tasksCounted = counted(tasks);
    if (tasksCounted.length === 0) {
        return { average: 0, median: 0, max: 0 };
    }

    const waits = tasksCounted.map((task) => queueSeconds(task, now)).sort((a, b) => a - b);
    const waiting = tasksCounted
        .filter((task) => WAITING.includes(task.Status))
        .map((task) => queueSeconds(task, now));

    const mid = Math.floor(waits.length / 2);

    return {
        average: waits.reduce((a, b) => a + b, 0) / waits.length,
        median: waits.length % 2 !== 0 ? waits[mid] : (waits[mid - 1] + waits[mid]) / 2,
        max: waiting.reduce((a, b) => (b > a ? b : a), 0),
    };
}

// Seconds as a human readable duration, at the precision the dashboard shows.
export function formatDuration(duration) {
    let hours = Math.floor(duration / 3600);
    let minutes = Math.floor((duration % 3600) / 60);
    const seconds = Math.round(duration % 60);

    if (hours > 0) {
        minutes = Math.round(minutes + seconds / 60);
        if (minutes >= 60) {
            hours += 1;
            minutes = 0;
        }
        return hours + 'h ' + minutes + 'm';
    }

    if (minutes > 0) {
        return minutes + 'm ' + seconds + 's';
    }

    return seconds + 's';
}
