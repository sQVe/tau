import { Key, matchesKey } from '@earendil-works/pi-tui';

export const isUp = (data: string): boolean => matchesKey(data, Key.up) || matchesKey(data, 'k');

export const isDown = (data: string): boolean =>
  matchesKey(data, Key.down) || matchesKey(data, 'j');

export const isTop = (data: string): boolean => matchesKey(data, Key.home) || matchesKey(data, 'g');

export const isBottom = (data: string): boolean =>
  matchesKey(data, Key.end) || matchesKey(data, Key.shift('g'));
