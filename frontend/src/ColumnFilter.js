import React from 'react';
import IconButton from '@mui/material/IconButton';
import Popover from '@mui/material/Popover';
import TextField from '@mui/material/TextField';
import FilterListIcon from '@mui/icons-material/FilterList';

// The filter button in a column header. It is highlighted while the column
// has a filter.
export function ColumnFilterButton({ label, active, onOpen, tabIndex }) {
  return (
    <IconButton
      size="small"
      tabIndex={tabIndex}
      aria-label={`Filter ${label}`}
      aria-pressed={active}
      onClick={(event) => {
        // Clicks on the header itself sort the column
        event.stopPropagation();
        onOpen(event.currentTarget);
      }}
    >
      <FilterListIcon fontSize="small" color={active ? 'primary' : 'action'} />
    </IconButton>
  );
}

// The field that edits the filter of a column, under its header. Rows are
// kept if the text of the column contains the filter.
export function ColumnFilterPopover({ label, value, anchor, onChange, onClose }) {
  return (
    <Popover
      open={Boolean(anchor)}
      anchorEl={anchor}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      {anchor && (
        <TextField
          autoFocus
          size="small"
          sx={{ m: 1, minWidth: 220 }}
          label={`Filter ${label}`}
          placeholder="Contains"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && onClose()}
        />
      )}
    </Popover>
  );
}

// Returns true if the texts match every word of a search.
export function matchesSearch(texts, search) {
  const text = texts.join('\n').toLowerCase();
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((term) => text.includes(term));
}

// Returns true if the row passes the filters of all columns. The columns are
// { key, text(row) } with the text the column shows.
export function matchesColumnFilters(row, columns, filters) {
  return columns.every((column) => !filters[column.key] ||
    String(column.text(row) ?? '').toLowerCase().includes(filters[column.key].toLowerCase()));
}
