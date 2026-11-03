import { expect, it } from 'vitest';

import { errorSendStatus, replySendStatus } from './sendStatus.js';

it.each([
  { name: 'true', started: true, expected: 'started' },
  { name: 'false', started: false, expected: 'notStarted' },
  { name: 'null', started: null, expected: 'notStarted' },
  { name: 'a missing field', started: undefined, expected: 'notStarted' },
])('maps a reply with started $name to $expected', ({ started, expected }) => {
  expect(replySendStatus(started)).toBe(expected);
});

it.each([
  { name: 'blocked', errorKind: 'blocked', expected: 'blocked' },
  { name: 'failed', errorKind: 'failed', expected: undefined },
  { name: 'not_found', errorKind: 'not_found', expected: undefined },
])('maps a $name hc error to $expected', ({ errorKind, expected }) => {
  expect(errorSendStatus(errorKind)).toBe(expected);
});
