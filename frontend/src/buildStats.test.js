import { buildDuration, buildRows, buildStatusName, buildsFromTasks, formatSeconds, isActive } from './buildStats';

const tasks = [
    { id: 'a', BuildId: 'b1', Status: 'Passed', Queued: '2026-10-29 10:00:00', Started: '2026-10-29 10:00:10', Ended: '2026-10-29 10:01:10' },
    { id: 'b', BuildId: 'b1', Status: 'Failed', Queued: '2026-10-29 09:59:00', Started: '2026-10-29 10:00:00', Ended: '2026-10-29 10:00:30' },
    { id: 'c', BuildId: 'b2', Status: 'Queued', Queued: '2026-10-29 10:05:00', Started: '', Ended: '' },
    { id: 'd', BuildId: '', Status: 'Queued', Queued: '2026-10-29 10:05:00', Started: '', Ended: '' },
];

test('tasks are grouped by build with their statistics', () => {
    const builds = buildsFromTasks(tasks);
    expect(builds.map((build) => build.id)).toEqual(['b1', 'b2']);
    const [b1] = builds;
    expect(b1.counts).toMatchObject({ Passed: 1, Failed: 1, Queued: 0 });
    expect(b1.total).toBe(2);
    expect(b1.firstQueued).toBe('2026-10-29 09:59:00');
    expect(b1.lastEnded).toBe('2026-10-29 10:01:10');
    expect(b1.taskTime).toBe(90);
    expect(buildDuration(b1, new Date('2026-10-29T12:00:00'))).toBe(130);
    // Unfinished builds last until now
    expect(buildDuration(builds[1], new Date('2026-10-29T10:06:00'))).toBe(60);
});

test('scheduler builds get statistics, also without tasks, and builds only tasks know are kept', () => {
    const rows = buildRows([
        { id: 'b1', Status: 'BUILD_COMPLETED', Owners: ['alice'], Parameters: [{ Key: 'config.x', Value: '1' }] },
        { id: 'empty', Status: 'BUILD_ACCEPTED' },
    ], tasks);
    expect(rows.map((row) => [row.id, row.total, row.Status])).toEqual([
        ['b1', 2, 'BUILD_COMPLETED'], ['empty', 0, 'BUILD_ACCEPTED'], ['b2', 1, ''],
    ]);
    expect(rows[0].Owners).toEqual(['alice']);
    expect(rows[1].Owners).toEqual([]);
});

test('build statuses and durations are readable', () => {
    expect(buildStatusName('BUILD_CANCELLED')).toBe('Cancelled');
    expect(buildStatusName('')).toBe('Unknown');
    expect(isActive({ Status: 'BUILD_ACCEPTED' })).toBe(true);
    expect(isActive({ Status: 'BUILD_COMPLETED' })).toBe(false);
    expect(formatSeconds(3723.25)).toBe('1h 2m 3.3s');
    expect(formatSeconds(null)).toBe('');
});
