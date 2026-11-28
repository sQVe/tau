import { expect, it } from 'vitest';

import { decideFreshness } from './freshness.js';
import type { RunRecord } from './records.js';

type FreshnessFacts = Pick<RunRecord, 'treeAtLaunch' | 'treeAtStop' | 'doctor' | 'stop'>;

const facts = (overrides: Partial<FreshnessFacts> = {}): FreshnessFacts => ({
  treeAtLaunch: 'tree-one',
  treeAtStop: 'tree-one',
  doctor: { exitCode: 0, logPath: 'doctor.log' },
  stop: { exitCode: 0, logPath: 'stop.log' },
  ...overrides,
});

it.each([
  {
    name: 'equal identities with doctor 0',
    record: facts(),
    currentTree: 'tree-one',
    expected: { fresh: true },
  },
  {
    name: 'a tree changed at stop',
    record: facts({ treeAtStop: 'tree-two' }),
    currentTree: 'tree-one',
    expected: { fresh: false, reason: 'treeChangedDuringRun' },
  },
  {
    name: 'a tree changed since the run',
    record: facts(),
    currentTree: 'tree-two',
    expected: { fresh: false, reason: 'treeChangedSinceRun' },
  },
  {
    name: 'doctor exit 1',
    record: facts({ doctor: { exitCode: 1, logPath: 'doctor.log' } }),
    currentTree: 'tree-one',
    expected: { fresh: false, reason: 'doctorFailed' },
  },
  {
    name: 'doctor null',
    record: facts({ doctor: null }),
    currentTree: 'tree-one',
    expected: { fresh: false, reason: 'doctorFailed' },
  },
  {
    name: 'doctor exit code null',
    record: facts({ doctor: { exitCode: null, logPath: 'doctor.log' } }),
    currentTree: 'tree-one',
    expected: { fresh: false, reason: 'doctorFailed' },
  },
  {
    name: 'null tree at launch',
    record: facts({ treeAtLaunch: null }),
    currentTree: 'tree-one',
    expected: { fresh: false, reason: 'noIdentity' },
  },
  {
    name: 'null tree at stop with a stop',
    record: facts({ treeAtStop: null }),
    currentTree: 'tree-one',
    expected: { fresh: false, reason: 'noIdentity' },
  },
  {
    name: 'null current tree',
    record: facts(),
    currentTree: null,
    expected: { fresh: false, reason: 'noIdentity' },
  },
  {
    name: 'a run not stopped',
    record: facts({ stop: null }),
    currentTree: 'tree-one',
    expected: { fresh: false, reason: 'notStopped' },
  },
  {
    name: 'a stop that exited nonzero',
    record: facts({ stop: { exitCode: 7, logPath: 'stop.log' } }),
    currentTree: 'tree-one',
    expected: { fresh: false, reason: 'stopFailed' },
  },
  {
    name: 'a stop that was killed',
    record: facts({ stop: { exitCode: null, logPath: 'stop.log' } }),
    currentTree: 'tree-one',
    expected: { fresh: false, reason: 'stopFailed' },
  },
])('decides $name', ({ record, currentTree, expected }) => {
  expect(decideFreshness(record, currentTree)).toEqual(expected);
});
