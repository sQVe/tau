import { Key, matchesKey } from '@earendil-works/pi-tui';

export const isUp = (data: string) => matchesKey(data, Key.up) || matchesKey(data, 'k');

export const isDown = (data: string) => matchesKey(data, Key.down) || matchesKey(data, 'j');

export const isTop = (data: string) => matchesKey(data, Key.home) || matchesKey(data, 'g');

export const isBottom = (data: string) =>
  matchesKey(data, Key.end) || matchesKey(data, Key.shift('g'));
