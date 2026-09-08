import { Key, matchesKey } from '@earendil-works/pi-tui';

const cursorUp = '\u001b[A';
const cursorDown = '\u001b[B';

// matchesKey resolves lowercase letters but not shifted ones, so G is compared
// against the raw byte.
const bottomKey = 'G';

export const isUp = (data: string) => matchesKey(data, Key.up) || matchesKey(data, 'k');

export const isDown = (data: string) => matchesKey(data, Key.down) || matchesKey(data, 'j');

export const isTop = (data: string) => matchesKey(data, Key.home) || matchesKey(data, 'g');

export const isBottom = (data: string) => matchesKey(data, Key.end) || data === bottomKey;

/**
 * Rewrites the vim keys as the arrow sequences pi's SelectList reads, which is
 * the only way to move it. It handles its own input and keeps its index
 * private, so tau cannot set the selection directly.
 */
export const toCursorKey = (data: string) => {
  if (isUp(data)) {
    return cursorUp;
  }

  if (isDown(data)) {
    return cursorDown;
  }

  return data;
};
