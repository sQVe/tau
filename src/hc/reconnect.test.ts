import { expect, it } from 'vitest';

import { decideReconnect, retryDelay } from './reconnect.js';
import type { ReconnectPlan } from './reconnect.js';

const retryTable: { name: string; attempt: number; expected: number | undefined }[] = [
  { name: 'waits 5 s after the first failure', attempt: 0, expected: 5_000 },
  { name: 'waits 15 s after the second failure', attempt: 1, expected: 15_000 },
  { name: 'waits 45 s after the third failure', attempt: 2, expected: 45_000 },
  { name: 'stops after the bounded schedule', attempt: 3, expected: undefined },
];

it.each(retryTable.map((row) => [row.name, row] as const))('%s', (_name, { attempt, expected }) => {
  expect(retryDelay(attempt)).toBe(expected);
});

const reconnectTable: { name: string; attempt: number; plan: ReconnectPlan }[] = [
  { name: 'uses the first retry delay', attempt: 0, plan: { delay: 5_000, lasting: false } },
  { name: 'uses the second retry delay', attempt: 1, plan: { delay: 15_000, lasting: false } },
  { name: 'uses the third retry delay', attempt: 2, plan: { delay: 45_000, lasting: false } },
  {
    name: 'caps at the last delay and reports a lasting failure',
    attempt: 3,
    plan: { delay: 45_000, lasting: true },
  },
  {
    name: 'keeps the last delay and the lasting failure for later attempts',
    attempt: 9,
    plan: { delay: 45_000, lasting: true },
  },
];

it.each(reconnectTable.map((row) => [row.name, row] as const))('%s', (_name, { attempt, plan }) => {
  expect(decideReconnect(attempt)).toEqual(plan);
});
