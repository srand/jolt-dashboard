import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import DataTable from './DataTable';

const rows = Array.from({ length: 30 }, (_, i) => ({ id: `row-${String(i).padStart(2, '0')}`, n: i }));
const columns = [{ key: 'id', label: 'ID' }, { key: 'n', label: 'Number' }];

function table(props) {
    return (
        <DataTable label="Rows" rowLabel="row" controlsLabel="Row controls" rows={rows} columns={columns}
            getId={(row) => row.id} defaultSort={{ key: 'n', order: 'asc' }} rowsPerPage={25} {...props} />
    );
}

function ids() {
    // An open column filter hides the rest of the page from assistive technology
    return within(screen.getByRole('table', { name: 'Rows', hidden: true })).getAllByRole('row', { hidden: true }).slice(1)
        .map((row) => row.querySelector('td').textContent);
}

test('rows are shown a page at a time', () => {
    render(table());
    expect(ids()).toHaveLength(25);
    expect(ids()[0]).toBe('row-00');
    userEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
    expect(ids()).toEqual(['row-25', 'row-26', 'row-27', 'row-28', 'row-29']);
    // Filtering starts over on the first page
    userEvent.click(screen.getByRole('button', { name: 'Filter ID' }));
    userEvent.type(screen.getByRole('textbox', { name: 'Filter ID' }), 'row-0');
    expect(ids()).toHaveLength(10);
});

test('a row selected from elsewhere is shown on its page', () => {
    const { rerender } = render(table());
    expect(ids()).not.toContain('row-28');
    rerender(table({ selectedId: 'row-28' }));
    expect(ids()).toContain('row-28');
});

test('the column chooser is not modal, so the table shows the change', () => {
    render(table());
    userEvent.click(screen.getByRole('button', { name: 'Show columns' }));
    userEvent.click(screen.getByRole('checkbox', { name: 'Number' }));
    expect(screen.queryByRole('columnheader', { name: 'Number' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Number' })).toBeInTheDocument();
    userEvent.keyboard('{Escape}');
});

test('clicking anywhere on a header sorts, but its filter button does not', () => {
    render(table({ rows: rows.slice(0, 3) }));
    const header = screen.getByRole('columnheader', { name: 'Number' });
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    userEvent.click(header);
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(ids()).toEqual(['row-02', 'row-01', 'row-00']);
    userEvent.click(within(header).getByRole('button', { name: 'Filter Number' }));
    userEvent.keyboard('{Escape}');
    expect(screen.getByRole('columnheader', { name: 'Number', hidden: true })).toHaveAttribute('aria-sort', 'descending');
});
