import { expect, it } from 'vitest';

import { decideReuse, sameReusableState } from './reuseDecision.js';
import type { CheckIdentity, SavedLog } from './reuseDecision.js';

type SavedRecord = Partial<Omit<CheckIdentity, 'fingerprint'>> & {
  fingerprint?: string;
  passed?: boolean;
};

const current: CheckIdentity = {
  head: 'head-one',
  base: 'base-one',
  argv: ['pnpm', 'check'],
  fingerprint: 'fingerprint-one',
};

const saved = (record: SavedRecord | undefined, logPath = 'a.log', logExists = true) =>
  ({
    logPath,
    read:
      record === undefined
        ? ({ status: 'malformed' } as const)
        : {
            status: 'valid' as const,
            record: {
              version: 2 as const,
              ...current,
              fingerprint: 'fingerprint-one',
              passed: true,
              ...record,
            },
          },
    logExists,
  }) satisfies SavedLog;

it.each([
  { name: 'no saved logs', logs: [], expected: { status: 'run' } },
  { name: 'a matching record', logs: [saved({})], expected: { status: 'reuse', logPath: 'a.log' } },
  {
    name: 'a matching record that failed',
    logs: [saved({ passed: false })],
    expected: { status: 'run' },
  },
  {
    name: 'a missing record',
    logs: [{ logPath: 'a.log', read: { status: 'missing' as const }, logExists: true }],
    expected: { status: 'run' },
  },
  { name: 'a malformed record', logs: [saved(undefined)], expected: { status: 'run' } },
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
    name: 'a failed record before a passing match',
    logs: [saved({ passed: false }, 'new.log'), saved({}, 'old.log')],
    expected: { status: 'run' },
  },
  {
    name: 'a newer record whose log is gone above a passing match',
    logs: [saved({ passed: false }, 'new.log', false), saved({}, 'old.log')],
    expected: { status: 'reuse', logPath: 'old.log' },
  },
  {
    name: 'a mismatch before a match',
    logs: [saved({ head: 'head-two' }, 'new.log'), saved({}, 'old.log')],
    expected: { status: 'reuse', logPath: 'old.log' },
  },
  {
    name: 'a newer failing record with another argv above an older passing match',
    logs: [saved({ passed: false, argv: ['pnpm', 'test'] }, 'new.log'), saved({}, 'old.log')],
    expected: { status: 'run' },
  },
  {
    name: 'a newer passing record with another argv above an older passing match',
    logs: [saved({ argv: ['pnpm', 'test'] }, 'new.log'), saved({}, 'old.log')],
    expected: { status: 'run' },
  },
  {
    name: 'two matches',
    logs: [saved({}, 'new.log'), saved({}, 'old.log')],
    expected: { status: 'reuse', logPath: 'new.log' },
  },
])('decides $expected.status for $name', ({ logs, expected }) => {
  expect(decideReuse(current, logs)).toEqual(expected);
});

it('never reuses a state without a fingerprint', () => {
  const dirty = { ...current, fingerprint: null };

  expect(decideReuse(dirty, [saved({})])).toEqual({ status: 'run' });
  expect(sameReusableState(dirty, dirty)).toBe(false);
  expect(sameReusableState(current, current)).toBe(true);
});
