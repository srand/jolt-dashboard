// Builds and their task statistics, derived from the task list. Like the
// metrics, these are pure functions of the tasks, computed in render.

export const TASK_STATUSES = ['Queued', 'Assigned', 'Running', 'Passed', 'Failed', 'Cancelled'];

const BUILD_STATUS_NAMES = {
  BUILD_ACCEPTED: 'Active',
  BUILD_REJECTED: 'Rejected',
  BUILD_COMPLETED: 'Completed',
  BUILD_CANCELLED: 'Cancelled',
};

export function buildStatusName(status) {
  return BUILD_STATUS_NAMES[status] || 'Unknown';
}

// Only active builds can be cancelled.
export function isActive(build) {
  return build.Status === 'BUILD_ACCEPTED';
}

function seconds(start, end) {
  if (!start || !end) {
    return null;
  }
  return (new Date(end) - new Date(start)) / 1000;
}

function emptyBuild(id) {
  return {
    id,
    Status: '',
    Scheduled: '',
    Origin: '',
    Parameters: [],
    Owners: [],
    counts: Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])),
    total: 0,
    firstQueued: '',
    lastEnded: '',
    taskTime: 0,
    taskInstances: new Set(),
  };
}

// Groups tasks by build. Builds the scheduler hasn't described yet still
// get a row, with only their ID.
export function buildsFromTasks(tasks) {
  const builds = new Map();
  for (const task of tasks) {
    if (!task.BuildId) {
      continue;
    }
    let build = builds.get(task.BuildId);
    if (!build) {
      build = emptyBuild(task.BuildId);
      builds.set(task.BuildId, build);
    }
    if (task.Build) {
      Object.assign(build, {
        Status: task.Build.Status || '',
        Scheduled: task.Build.Scheduled || '',
        Origin: task.Build.Origin || '',
        Parameters: task.Build.Parameters || [],
        Owners: task.Build.Owners || [],
      });
    }
    build.total += 1;
    if (task.Status in build.counts) {
      build.counts[task.Status] += 1;
    }
    if (task.Queued && (!build.firstQueued || task.Queued < build.firstQueued)) {
      build.firstQueued = task.Queued;
    }
    if (task.Ended && task.Ended > build.lastEnded) {
      build.lastEnded = task.Ended;
    }
    build.taskTime += seconds(task.Started, task.Ended) || 0;
    build.taskInstances.add(task.id);
  }
  return Array.from(builds.values());
}

// Formats seconds as "1h 2m 3s".
export function formatSeconds(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = Math.round((value % 60) * 10) / 10;
  if (hours) {
    return `${hours}h ${minutes}m ${rest}s`;
  }
  return minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

// Wall-clock time from the first queued task to the last finished one, or
// to now while tasks remain.
export function buildDuration(build, now) {
  if (!build.firstQueued) {
    return null;
  }
  const unfinished = build.counts.Queued + build.counts.Assigned + build.counts.Running;
  const end = unfinished || !build.lastEnded ? new Date(now) : new Date(build.lastEnded);
  return (end - new Date(build.firstQueued)) / 1000;
}

// The builds of the scheduler, with the statistics of their tasks. Builds
// that only tasks refer to are included too.
export function buildRows(builds, tasks) {
  const stats = new Map(buildsFromTasks(tasks).map((build) => [build.id, build]));
  const rows = builds.map((build) => {
    const row = stats.get(build.id) || emptyBuild(build.id);
    stats.delete(build.id);
    return {
      ...row,
      Status: build.Status || '',
      Scheduled: build.Scheduled || '',
      Origin: build.Origin || '',
      Parameters: build.Parameters || [],
      Owners: build.Owners || [],
    };
  });
  return rows.concat(Array.from(stats.values()));
}
