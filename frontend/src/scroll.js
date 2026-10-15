// How far from the bottom still counts as "at the bottom", in pixels. Gives
// the user room to be a line off without us fighting their scrolling.
const THRESHOLD = 24;

export function isScrolledToBottom(element, threshold = THRESHOLD) {
    if (!element) {
        return true;
    }

    const { scrollTop, scrollHeight, clientHeight } = element;
    return scrollHeight - scrollTop - clientHeight <= threshold;
}
