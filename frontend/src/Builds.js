import React from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import StopCircleIcon from '@mui/icons-material/StopCircle';

import Attribution from './Attribution';
import DataTable from './DataTable';
import { TASK_STATUSES, buildDuration, buildStatusName, formatSeconds, isActive } from './buildStats';

const COLUMN_VISIBILITY_STORAGE_KEY = 'jolt-dashboard.builds.columnVisibility.v1';

const STATUSES = ['Active', 'Completed', 'Cancelled', 'Rejected'];

// Tasks that haven't finished. The expanded row shows all of them.
const ACTIVE_TASK_STATUSES = ['Queued', 'Assigned', 'Running'];

function shortId(id) {
  return id.length > 12 ? id.slice(0, 12) : id;
}

function scheduled(build) {
  return build.Scheduled || build.firstQueued;
}

function activeTasks(build) {
  return ACTIVE_TASK_STATUSES.reduce((total, status) => total + build.counts[status], 0);
}

// "2 Queued, 3 Running" for the unfinished tasks.
function taskSummary(build) {
  return ACTIVE_TASK_STATUSES.filter((status) => build.counts[status] > 0)
    .map((status) => `${build.counts[status]} ${status}`)
    .join(', ');
}

// The texts of a build that the search field matches.
function searchTexts(build) {
  return [
    build.id,
    build.Origin,
    ...build.Owners,
    ...build.Parameters.map(({ Key, Value }) => `${Key.replace(/^config\./, '')}=${Value}`),
  ];
}

function stopTooltip(build, user) {
  if (!isActive(build)) {
    return 'The build has ended';
  }
  if (!user) {
    return 'Sign in to stop builds';
  }
  if (build.Owners.includes(user.name)) {
    return 'Stop your build';
  }
  return 'Stop build (only its owners and administrators may)';
}

function DetailTable({ title, rows, label }) {
  return (
    <Box sx={{ minWidth: 220, flex: 1 }}>
      <Typography variant="subtitle2" gutterBottom>{title}</Typography>
      <Table size="small" aria-label={label}>
        <TableBody>
          {rows.map(([key, value]) => (
            <TableRow key={key}>
              <TableCell component="th" scope="row" sx={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{key}</TableCell>
              <TableCell sx={{ wordBreak: 'break-all' }}>{value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

function BuildDetails({ build }) {
  const parameters = build.Parameters.map(({ Key, Value }) => [Key.replace(/^config\./, ''), Value]);
  return (
    <Box sx={{ my: 2, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      <DetailTable
        title="Tasks"
        label="Task statistics"
        rows={[
          ...TASK_STATUSES.map((status) => [status, build.counts[status]]),
          ['Total', build.total],
          ['First queued', build.firstQueued || '-'],
          ['Last finished', build.lastEnded || '-'],
          ['Task time', formatSeconds(build.taskTime)],
        ]}
      />
      <DetailTable
        title="Build"
        label="Build details"
        rows={[
          ['ID', build.id],
          ['Owners', build.Owners.length ? build.Owners.join(', ') : '-'],
        ]}
      />
      <DetailTable
        title="Parameters"
        label="Build parameters"
        rows={parameters.length ? parameters : [['-', 'No parameters']]}
      />
    </Box>
  );
}

class Builds extends React.Component {
  columns() {
    const { now, user, filterBuildId, onFilter, onStop } = this.props;
    return [
      { key: 'status', label: 'Status', value: (build) => buildStatusName(build.Status) },
      {
        key: 'build', label: 'Build', value: (build) => build.id,
        render: (build) => <span title={build.id}>{shortId(build.id)}</span>,
        sx: { fontFamily: 'monospace' },
      },
      {
        key: 'owners', label: 'Owners', value: (build) => build.Owners.join(', '),
        render: (build) => <Attribution value={build.Owners.join(', ')} compact textOnly />,
        sx: { maxWidth: 160 },
      },
      {
        key: 'origin', label: 'Origin', value: (build) => build.Origin,
        render: (build) => <Attribution value={build.Origin} compact />,
        sx: { maxWidth: 260 },
      },
      { key: 'scheduled', label: 'Scheduled', value: scheduled, text: (build) => build.Scheduled, sx: { whiteSpace: 'nowrap' } },
      { key: 'tasks', label: 'Tasks', value: activeTasks, text: taskSummary },
      {
        key: 'duration', label: 'Duration', value: (build) => buildDuration(build, now) ?? -1,
        text: (build) => formatSeconds(buildDuration(build, now)), sx: { whiteSpace: 'nowrap' },
      },
      {
        key: 'actions', label: 'Actions', sortable: false, filterable: false, stopClick: true,
        sx: { whiteSpace: 'nowrap', py: 0 },
        render: (build) => {
          const filtered = filterBuildId === build.id;
          return (
            <>
              <Tooltip title={filtered ? 'Show all tasks and workers' : 'Show only the tasks and workers of this build'}>
                <IconButton
                  aria-label={filtered ? 'Clear build filter' : 'Filter by build'}
                  aria-pressed={filtered}
                  onClick={() => onFilter(filtered ? null : build.id)}
                >
                  {filtered ? <FilterAltIcon color="primary" /> : <FilterAltOutlinedIcon />}
                </IconButton>
              </Tooltip>
              <Tooltip title={stopTooltip(build, user)}>
                {/* Disabled buttons don't fire the events that tooltips need */}
                <span>
                  <IconButton aria-label="Stop build" color="error" disabled={!user || !isActive(build)} onClick={() => onStop(build)}>
                    <StopCircleIcon />
                  </IconButton>
                </span>
              </Tooltip>
            </>
          );
        },
      },
    ];
  }

  render() {
    const { builds, expanded, selectedBuildId, onToggle } = this.props;
    return (
      <div className="w3-container w3-cell-row w3-margin-top">
        <DataTable
          label="Builds"
          rowLabel="build"
          controlsLabel="Build controls"
          rows={builds}
          columns={this.columns()}
          getId={(build) => build.id}
          defaultSort={{ key: 'scheduled', order: 'desc' }}
          storageKey={COLUMN_VISIBILITY_STORAGE_KEY}
          statuses={STATUSES}
          statusOf={(build) => buildStatusName(build.Status)}
          searchLabel="Search builds"
          searchPlaceholder="ID, owner, origin or parameter"
          searchTexts={searchTexts}
          renderDetails={(build) => <BuildDetails build={build} />}
          expanded={expanded}
          selectedId={selectedBuildId}
          onToggle={onToggle}
        />
      </div>
    );
  }
}

export default Builds;
