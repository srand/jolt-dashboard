import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import Attribution from './Attribution';

test.each([
    'https://ci.example.com/build/123?branch=main&job=test#results',
    'http://localhost:8080/build/123',
    'HTTPS://ci.example.com/build/123',
])('renders absolute HTTP(S) origins as safe external links: %s', (value) => {
    render(<Attribution value={value} />);
    const link = screen.getByRole('link', { name: value });
    expect(link).toHaveAttribute('href', value);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

describe.each([false, true])('missing attribution (compact=%s)', (compact) => {
    test.each([
        ['', false], [undefined, false], [null, false],
        ['', true], [undefined, true], [null, true],
    ])('renders an empty value without a link or title (value=%s, textOnly=%s)', (value, textOnly) => {
        render(<Attribution value={value} compact={compact} textOnly={textOnly} />);
        const field = screen.getByText('', { selector: 'span' });
        expect(field).toBeEmptyDOMElement();
        expect(field).not.toHaveAttribute('title');
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });
});

test.each([
    'builder@example.com',
    'manual build from laptop',
    'mailto:builder@example.com',
    // eslint-disable-next-line no-script-url -- Unsafe origins must stay text.
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///tmp/build',
    'ftp://ci.example.com/build/123',
    '//ci.example.com/build/123',
    '/build/123',
    'https:ci.example.com',
    'https:///ci.example.com',
    'https://',
    'https://invalid host/build',
    'https://ci.example.com:invalid/build',
    'https://ci.example.com\\build',
    'https://ci.example.com/\nscript',
    'https://ci.example.com/\u0000script',
    '<img src=x onerror="alert(1)">',
])('renders arbitrary, unsafe or non-HTTP origins as text: %s', (value) => {
    const { container } = render(<Attribution value={value} />);
    expect(container.textContent).toBe(value);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

test.each(['builder@example.com', 'mailto:builder@example.com', 'https://ci.example.com/user', '<script>user</script>'])('usernames are always safely rendered text: %s', (value) => {
    const { container } = render(<Attribution value={value} textOnly />);
    expect(container.textContent).toBe(value);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
});

test.each([false, true])('compact attribution retains full text and title (textOnly=%s)', (textOnly) => {
    const value = 'https://ci.example.com/build/' + 'long-path/'.repeat(20);
    render(<Attribution value={value} compact textOnly={textOnly} />);
    const field = screen.getByTitle(value);
    expect(field.textContent).toBe(value);
    expect(field).toHaveStyle({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
});

test('an origin link click does not bubble to its parent', () => {
    const onClick = jest.fn();
    render(<div onClick={onClick}><Attribution value="https://ci.example.com/build/123" /></div>);
    userEvent.click(screen.getByRole('link'));
    expect(onClick).not.toHaveBeenCalled();
});

test.each([false, true])('full attribution stays on one line without truncation (textOnly=%s)', (textOnly) => {
    const value = 'manual submission ' + 'long description '.repeat(20);
    render(<Attribution value={value} textOnly={textOnly} />);
    const field = screen.getByTitle(value, { normalizer: (text) => text });
    expect(field.textContent).toBe(value);
    expect(field).toHaveStyle({ whiteSpace: 'nowrap' });
    expect(field).not.toHaveStyle({ textOverflow: 'ellipsis' });
});
