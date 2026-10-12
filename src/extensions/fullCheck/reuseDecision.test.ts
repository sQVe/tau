import { expect, it } from 'vitest';

import { decideReuse } from './reuseDecision.js';
import type { CheckIdentity, SavedLog } from './reuseDecision.js';

const current: CheckIdentity = {
  head: 'head-one',
  base: 'base-one',
  argv: ['pnpm', 'check'],
  fingerprint: 'fingerprint-one',
};

const saved = (record: Partial<CheckIdentity> | undefined, logPath = 'a.log', logExists = true) =>
  ({
    logPath,
    record: record === undefined ? undefined : { ...current, ...record },
    logExists,
  }) satisfies SavedLog;

it.each([
  { name: 'no saved logs', logs: [], expected: { status: 'run' } },
  { name: 'a matching record', logs: [saved({})], expected: { status: 'reuse', logPath: 'a.log' } },
  { name: 'a missing or malformed record', logs: [saved(undefined)], expected: { status: 'run' } },
  {
    name: 'a matching record with no log',
    logs: [saved({}, 'a.log', false)],
    expected: { status: 'run' },
  },
  { name: 'another head', logs: [saved({ head: 'head-two' })], expected: { status: 'run' } },
  { name: 'another base', logs: [saved({ base: 'base-two' })], expected: { status: 'run' } },
  { name: 'no base on one side', logs: [saved({ base: null })], expected: { status: 'run' } },
  {
    name: 'another fingerprint',
    logs: [saved({ fingerprint: 'fingerprint-two' })],
    expected: { status: 'run' },
  },
  { name: 'another argv', logs: [saved({ argv: ['pnpm', 'test'] })], expected: { status: 'run' } },
  {
    name: 'a longer argv',
    logs: [saved({ argv: ['pnpm', 'check', '-r'] })],
    expected: { status: 'run' },
  },
  {
    name: 'a mismatch before a match',
    logs: [saved({ head: 'head-two' }, 'new.log'), saved({}, 'old.log')],
    expected: { status: 'reuse', logPath: 'old.log' },
  },
  {
    name: 'two matches',
    logs: [saved({}, 'new.log'), saved({}, 'old.log')],
    expected: { status: 'reuse', logPath: 'new.log' },
  },
])('decides $expected.status for $name', ({ logs, expected }) => {
  expect(decideReuse(current, logs)).toEqual(expected);
});
