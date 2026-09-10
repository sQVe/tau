import { Key, matchesKey } from '@earendil-works/pi-tui';

const cursorUp = '\u001b[A';
const cursorDown = '\u001b[B';

export const isUp = (data: string) => matchesKey(data, Key.up) || matchesKey(data, 'k');

export const isDown = (data: string) => matchesKey(data, Key.down) || matchesKey(data, 'j');

export const isTop = (data: string) => matchesKey(data, Key.home) || matchesKey(data, 'g');

export const isBottom = (data: string) =>
  matchesKey(data, Key.end) || matchesKey(data, Key.shift('g'));

/**
 * Rewrites Vim keys as the arrow sequences Pi's SelectList reads.
 * SelectList keeps its current index private, so forwarding input preserves
 * its movement and wraparound behavior without tracking another index.
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
