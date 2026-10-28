import React from 'react';
import Box from '@mui/material/Box';
import Portal from '@mui/material/Portal';
import { GridToolbarColumnsButton } from '@mui/x-data-grid';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

import PauseButton from './PauseButton';

class TasksToolbar extends React.Component {
  render() {
    const { container, filters, updating, onFiltersChange, onPause, onPlay } = this.props;
    return (
      // Keep the grid context for the built-in chooser, but render outside its border.
      <Portal container={container}>
        <Box
          display="flex"
          alignItems="center"
          justifyContent="space-between"
          flexWrap="wrap"
          gap={2}
        >
          <GridToolbarColumnsButton
            aria-label="Show columns"
            variant="outlined"
            size="medium"
            sx={{ height: 48 }}
          />
          <Box
            role="toolbar"
            aria-label="Task controls"
            display="flex"
            alignItems="center"
            justifyContent="flex-end"
            flexWrap="wrap"
            gap={2}
          >
            <PauseButton color="primary" selected={updating} onPause={onPause} onPlay={onPlay} />
            <ToggleButtonGroup value={filters} onChange={(event, value) => onFiltersChange(value)}>
              {['Queued', 'Assigned', 'Running', 'Passed', 'Failed', 'Cancelled'].map((status) => (
                <ToggleButton key={status} color="primary" value={status}>{status}</ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>
        </Box>
      </Portal>
    );
  }
}

export default TasksToolbar;
