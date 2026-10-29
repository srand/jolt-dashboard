import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Collapse from '@mui/material/Collapse';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import Popper from '@mui/material/Popper';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TablePagination from '@mui/material/TablePagination';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import ViewColumnIcon from '@mui/icons-material/ViewColumn';

import { ColumnFilterButton, ColumnFilterPopover, matchesColumnFilters, matchesSearch } from './ColumnFilter';

const ROWS_PER_PAGE = [25, 50, 100, 250];

// A short line between header cells, like the separators of a data grid.
const HEADER_SEPARATOR = {
  position: 'relative',
  '&:not(:last-of-type)::after': {
    content: '""',
    position: 'absolute',
    right: 0,
    top: '25%',
    height: '50%',
    borderRight: 1,
    borderColor: 'divider',
  },
};

// Padding of the cells of rows, between the small and the medium size.
const ROW_PADDING = { py: 1.25 };

// Columns are { key, label, value(row), text(row), render(row), sortable,
// filterable, hideable, sx }. value sorts the column, text filters it and
// render shows it; each defaults to the previous one.
function columnValue(column, row) {
  return column.value ? column.value(row) : row[column.key];
}

function columnText(column, row) {
  return column.text ? column.text(row) : columnValue(column, row);
}

function compare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a ?? '').localeCompare(String(b ?? ''));
}

// The saved visibility of the columns. Unknown columns and values that
// aren't booleans are ignored, and new columns are visible.
export function loadColumnVisibility(storageKey, columns) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
      return {};
    }
    return Object.fromEntries(columns
      .filter(({ key }) => Object.prototype.hasOwnProperty.call(saved, key) && typeof saved[key] === 'boolean')
      .map(({ key }) => [key, saved[key]]));
  } catch {
    // Corrupt or unavailable storage must not prevent the table from loading.
    return {};
  }
}

class DataRow extends React.Component {
  constructor(props) {
    super(props);
    this.rowRef = React.createRef();
  }

  componentDidMount() {
    this.scrollIfSelected(false);
  }

  componentDidUpdate(prevProps) {
    this.scrollIfSelected(prevProps.selected);
  }

  scrollIfSelected(wasSelected) {
    if (this.props.selected && !wasSelected) {
      this.rowRef.current?.scrollIntoView?.({ block: 'center' });
    }
  }

  render() {
    const { row, rowLabel, columns, expandable, expanded, selected, renderDetails, onToggle } = this.props;
    return (
      <React.Fragment>
        <TableRow
          ref={this.rowRef}
          hover
          selected={selected}
          aria-expanded={expandable ? expanded : undefined}
          onClick={expandable ? onToggle : undefined}
          sx={expandable ? { cursor: 'pointer', '& > *': { borderBottom: 'unset' } } : undefined}
        >
          {expandable && (
            <TableCell padding="checkbox">
              {/* The row toggles on click; the button is for keyboards and screen readers */}
              <IconButton
                size="small"
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${rowLabel}`}
                onClick={(event) => { event.stopPropagation(); onToggle(); }}
              >
                {expanded ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
              </IconButton>
            </TableCell>
          )}
          {columns.map((column) => (
            <TableCell
              key={column.key}
              data-field={column.key}
              sx={{ ...ROW_PADDING, ...column.sx }}
              // Buttons in a cell act on their own, without expanding the row
              onClick={column.stopClick ? (event) => event.stopPropagation() : undefined}
            >
              {column.render ? column.render(row) : columnText(column, row)}
            </TableCell>
          ))}
        </TableRow>
        {expandable && (
          <TableRow>
            <TableCell sx={{ py: 0 }} colSpan={columns.length + 1}>
              <Collapse in={expanded} timeout="auto" unmountOnExit>
                {renderDetails(row)}
              </Collapse>
            </TableCell>
          </TableRow>
        )}
      </React.Fragment>
    );
  }
}

// A table with a search field, status buttons, sortable and filterable
// columns that can be hidden, and pages. Rows may expand to show details.
class DataTable extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      orderBy: props.defaultSort.key,
      order: props.defaultSort.order,
      search: '',
      statuses: props.statuses || [],
      columnFilters: {},
      filterColumn: null,
      filterAnchor: null,
      visibility: props.storageKey ? loadColumnVisibility(props.storageKey, props.columns) : {},
      chooserAnchor: null,
      page: 0,
      rowsPerPage: props.rowsPerPage || 100,
    };
  }

  componentDidUpdate(prevProps) {
    // Show the page of a row that was selected from elsewhere
    const { selectedId } = this.props;
    if (selectedId && selectedId !== prevProps.selectedId) {
      const index = this.filteredRows().findIndex((row) => this.props.getId(row) === selectedId);
      if (index >= 0) {
        this.setState({ page: Math.floor(index / this.state.rowsPerPage) });
      }
    }
  }

  setVisibility(visibility) {
    this.setState({ visibility });
    if (this.props.storageKey) {
      try {
        window.localStorage.setItem(this.props.storageKey, JSON.stringify(visibility));
      } catch {
        // The table still keeps the choice for this session if storage is blocked or full.
      }
    }
  }

  sortBy(key) {
    this.setState((prevState) => ({
      orderBy: key,
      order: prevState.orderBy === key && prevState.order === 'asc' ? 'desc' : 'asc',
    }));
  }

  // The rows that pass the search, the status buttons and the column
  // filters, sorted.
  filteredRows() {
    const { rows, columns, statuses, statusOf, searchTexts, defaultSort } = this.props;
    const { orderBy, order, search, columnFilters } = this.state;
    const column = columns.find(({ key }) => key === orderBy) || columns.find(({ key }) => key === defaultSort.key);
    const fallback = columns.find(({ key }) => key === defaultSort.key);
    const direction = order === 'asc' ? 1 : -1;
    const fallbackDirection = defaultSort.order === 'asc' ? 1 : -1;
    const filterColumns = columns.filter(({ filterable }) => filterable !== false)
      .map((c) => ({ key: c.key, text: (row) => columnText(c, row) }));
    return rows
      .filter((row) =>
        (!statuses || !statuses.includes(statusOf(row)) || this.state.statuses.includes(statusOf(row))) &&
        (!searchTexts || matchesSearch(searchTexts(row), search)) &&
        matchesColumnFilters(row, filterColumns, columnFilters))
      // Ties keep the default order
      .sort((a, b) => direction * compare(columnValue(column, a), columnValue(column, b)) ||
        fallbackDirection * compare(columnValue(fallback, a), columnValue(fallback, b)));
  }

  renderToolbar() {
    const { controlsLabel, columns, statuses, searchLabel, searchPlaceholder, controls } = this.props;
    const { visibility, chooserAnchor } = this.state;
    const hideable = columns.filter(({ hideable: h }) => h !== false);
    return (
      <Box display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={2} sx={{ mb: 2 }}>
        {searchLabel ? (
          <TextField
            label={searchLabel}
            placeholder={searchPlaceholder}
            value={this.state.search}
            onChange={(event) => this.setState({ search: event.target.value, page: 0 })}
            sx={{ minWidth: 300 }}
          />
        ) : <span />}
        <Box
          role="toolbar"
          aria-label={controlsLabel}
          display="flex"
          alignItems="center"
          justifyContent="flex-end"
          flexWrap="wrap"
          gap={2}
        >
          {controls}
          <Button
            aria-label="Show columns"
            variant="outlined"
            size="medium"
            startIcon={<ViewColumnIcon />}
            sx={{ height: 48 }}
            aria-expanded={Boolean(chooserAnchor)}
            onClick={(event) => {
              const anchor = event.currentTarget;
              this.setState((prevState) => ({ chooserAnchor: prevState.chooserAnchor ? null : anchor }));
            }}
          >
            Columns
          </Button>
          {/* Not modal, so that the table shows the columns change */}
          <Popper open={Boolean(chooserAnchor)} anchorEl={chooserAnchor} placement="bottom-start" sx={{ zIndex: 1300 }}>
            <ClickAwayListener onClickAway={(event) => {
              if (!chooserAnchor?.contains(event.target)) {
                this.setState({ chooserAnchor: null });
              }
            }}>
            <Paper
              elevation={8}
              sx={{ p: 2, display: 'flex', flexDirection: 'column' }}
              onKeyDown={(event) => event.key === 'Escape' && this.setState({ chooserAnchor: null })}
            >
              {hideable.map((column) => (
                <FormControlLabel
                  key={column.key}
                  label={column.label}
                  control={(
                    <Checkbox
                      checked={visibility[column.key] !== false}
                      onChange={(event) => this.setVisibility({ ...visibility, [column.key]: event.target.checked })}
                    />
                  )}
                />
              ))}
              <Box display="flex" justifyContent="space-between" gap={1} sx={{ mt: 1 }}>
                <Button onClick={() => this.setVisibility(Object.fromEntries(hideable.map(({ key }) => [key, false])))}>
                  Hide all
                </Button>
                <Button onClick={() => this.setVisibility(Object.fromEntries(hideable.map(({ key }) => [key, true])))}>
                  Show all
                </Button>
              </Box>
            </Paper>
            </ClickAwayListener>
          </Popper>
          {statuses && (
            <ToggleButtonGroup
              value={this.state.statuses}
              onChange={(event, value) => this.setState({ statuses: value, page: 0 })}
            >
              {statuses.map((status) => (
                <ToggleButton key={status} color="primary" value={status}>{status}</ToggleButton>
              ))}
            </ToggleButtonGroup>
          )}
        </Box>
      </Box>
    );
  }

  render() {
    const { label, rowLabel, rows, getId, renderDetails, expanded = [], selectedId, onToggle } = this.props;
    const { orderBy, order, columnFilters, filterColumn, filterAnchor, visibility, rowsPerPage } = this.state;
    const columns = this.props.columns.filter(({ key }) => visibility[key] !== false);
    const filtered = this.filteredRows();
    // Stay on the last page when filters shorten the list
    const page = Math.min(this.state.page, Math.max(0, Math.ceil(filtered.length / rowsPerPage) - 1));
    const shown = filtered.slice(page * rowsPerPage, (page + 1) * rowsPerPage);
    const expandable = Boolean(renderDetails);
    const width = columns.length + (expandable ? 1 : 0);
    return (
      <div>
        {this.renderToolbar()}
        <ColumnFilterPopover
          label={this.props.columns.find(({ key }) => key === filterColumn)?.label || ''}
          value={columnFilters[filterColumn] || ''}
          anchor={filterAnchor}
          onChange={(value) => this.setState((prevState) => ({
            columnFilters: { ...prevState.columnFilters, [filterColumn]: value }, page: 0,
          }))}
          onClose={() => this.setState({ filterColumn: null, filterAnchor: null })}
        />
        <TableContainer component={Paper} variant="outlined">
          <Table aria-label={label} size="small">
            <TableHead>
              <TableRow>
                {expandable && <TableCell padding="checkbox" sx={HEADER_SEPARATOR} />}
                {columns.map((column) => {
                  const sortable = column.sortable !== false;
                  return (
                    <TableCell
                      key={column.key}
                      // Named by its label alone, not also by its filter button
                      aria-label={column.label}
                      sortDirection={orderBy === column.key ? order : false}
                      // The whole header sorts; the filter button stops its clicks
                      onClick={sortable ? () => this.sortBy(column.key) : undefined}
                      sx={{
                        ...HEADER_SEPARATOR,
                        whiteSpace: 'nowrap',
                        fontWeight: 500,
                        cursor: sortable ? 'pointer' : undefined,
                        userSelect: 'none',
                        '&:hover': sortable ? { backgroundColor: 'action.hover' } : undefined,
                      }}
                    >
                      <Box display="flex" alignItems="center" justifyContent="space-between" gap={1}>
                        {sortable ? (
                          <TableSortLabel
                            active={orderBy === column.key}
                            direction={orderBy === column.key ? order : 'asc'}
                          >
                            {column.label}
                          </TableSortLabel>
                        ) : column.label}
                        {column.filterable !== false && (
                          <ColumnFilterButton
                            label={column.label}
                            active={Boolean(columnFilters[column.key])}
                            onOpen={(anchor) => this.setState({ filterColumn: column.key, filterAnchor: anchor })}
                          />
                        )}
                      </Box>
                    </TableCell>
                  );
                })}
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={width} align="center">
                    {rows.length ? `No matching ${label.toLowerCase()}` : `No ${label.toLowerCase()}`}
                  </TableCell>
                </TableRow>
              )}
              {shown.map((row) => (
                <DataRow
                  key={getId(row)}
                  row={row}
                  rowLabel={rowLabel}
                  columns={columns}
                  expandable={expandable}
                  expanded={expanded.includes(getId(row))}
                  selected={selectedId === getId(row)}
                  renderDetails={renderDetails}
                  onToggle={() => onToggle(getId(row))}
                />
              ))}
            </TableBody>
          </Table>
          <TablePagination
            component="div"
            count={filtered.length}
            page={page}
            rowsPerPage={rowsPerPage}
            rowsPerPageOptions={ROWS_PER_PAGE}
            onPageChange={(event, value) => this.setState({ page: value })}
            onRowsPerPageChange={(event) => this.setState({ rowsPerPage: Number(event.target.value), page: 0 })}
          />
        </TableContainer>
      </div>
    );
  }
}

export default DataTable;
