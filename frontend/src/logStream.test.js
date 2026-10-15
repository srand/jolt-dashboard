import { TextDecoder as NodeTextDecoder } from 'util';

import { createLineBuffer, createLogDecoder, isTerminalStatus } from './logStream';

// jsdom does not define TextDecoder, so borrow node's. createLogDecoder reads
// the global when it is called, not when this module is imported, so assigning
// it here is in time.
global.TextDecoder = global.TextDecoder || NodeTextDecoder;

test('emits nothing until a line is complete', () => {
    const buffer = createLineBuffer();
    expect(buffer.push("2026-10-15 10:00:00.000000 [   INFO] par")).toBe("");
});

test('emits a line once its newline arrives', () => {
    const buffer = createLineBuffer();
    buffer.push("first half ");
    expect(buffer.push("second half\n")).toBe("first half second half\n");
});

test('emits every complete line in a chunk and holds the remainder', () => {
    const buffer = createLineBuffer();
    expect(buffer.push("one\ntwo\nthr")).toBe("one\ntwo\n");
    expect(buffer.push("ee\n")).toBe("three\n");
});

test('emits nothing for an empty chunk', () => {
    const buffer = createLineBuffer();
    expect(buffer.push("")).toBe("");
});

test('flush returns the trailing partial line', () => {
    const buffer = createLineBuffer();
    buffer.push("no newline here");
    expect(buffer.flush()).toBe("no newline here");
    expect(buffer.flush()).toBe("");
});

test('flush returns nothing when every line was complete', () => {
    const buffer = createLineBuffer();
    buffer.push("done\n");
    expect(buffer.flush()).toBe("");
});

// Review Focus 5.
test('a multi-byte character split across chunks survives', () => {
    const decoder = createLogDecoder();

    // "ä" is 0xC3 0xA4, and the chunk boundary falls between its two bytes.
    expect(decoder.push(new Uint8Array([0x61, 0xC3]))).toBe("");
    expect(decoder.push(new Uint8Array([0xA4, 0x0A]))).toBe("aä\n");
});

test('the decoder flushes a trailing line that never got a newline', () => {
    const decoder = createLogDecoder();

    expect(decoder.push(new Uint8Array([0x61, 0x62]))).toBe("");
    expect(decoder.flush()).toBe("ab");
});

test('terminal statuses are the ones that stop a task', () => {
    expect(isTerminalStatus("Passed")).toBe(true);
    expect(isTerminalStatus("Failed")).toBe(true);
    expect(isTerminalStatus("Cancelled")).toBe(true);
    expect(isTerminalStatus("Deleted")).toBe(true);
    expect(isTerminalStatus("Queued")).toBe(false);
    expect(isTerminalStatus("Assigned")).toBe(false);
    expect(isTerminalStatus("Running")).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
});
