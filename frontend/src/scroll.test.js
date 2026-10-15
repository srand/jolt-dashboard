import { isScrolledToBottom } from './scroll';

test('a view scrolled to the end is at the bottom', () => {
    expect(isScrolledToBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
});

test('a view a few pixels short still counts as the bottom', () => {
    expect(isScrolledToBottom({ scrollTop: 790, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
});

test('a view scrolled up is not at the bottom', () => {
    expect(isScrolledToBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 200 })).toBe(false);
});

test('a view shorter than its container is at the bottom', () => {
    expect(isScrolledToBottom({ scrollTop: 0, scrollHeight: 150, clientHeight: 200 })).toBe(true);
});

test('a missing element is treated as the bottom, so following starts on', () => {
    expect(isScrolledToBottom(null)).toBe(true);
});
