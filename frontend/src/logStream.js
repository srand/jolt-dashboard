// The log arrives as a byte stream, so a chunk can end mid-line. The level
// filters in TaskLog index fixed columns, so a half-delivered line must never
// reach the view.
export function createLineBuffer() {
    let pending = "";

    return {
        // Returns the complete lines in this chunk, or "" if there are none.
        push(chunk) {
            pending += chunk;

            const end = pending.lastIndexOf("\n");
            if (end === -1) {
                return "";
            }

            const complete = pending.slice(0, end + 1);
            pending = pending.slice(end + 1);
            return complete;
        },

        // Called when the stream ends, to emit a last line with no newline.
        flush() {
            const rest = pending;
            pending = "";
            return rest;
        },
    };
}

// One TextDecoder for the whole response: a multi-byte character split across
// two chunks is only decoded correctly if the same decoder sees both halves.
export function createLogDecoder() {
    const decoder = new TextDecoder();
    const lines = createLineBuffer();

    return {
        push(bytes) {
            return lines.push(decoder.decode(bytes, { stream: true }));
        },

        flush() {
            return lines.push(decoder.decode()) + lines.flush();
        },
    };
}

const TERMINAL_STATUSES = ["Passed", "Failed", "Cancelled", "Deleted"];

export function isTerminalStatus(status) {
    return TERMINAL_STATUSES.includes(status);
}
