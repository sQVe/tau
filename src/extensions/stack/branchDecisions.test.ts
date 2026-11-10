import { expect, it } from 'vitest';

import {
  decideBranchCheckout,
  decideBranchParent,
  decideBranchView,
  decideBranchWrite,
  decideParentHistory,
} from './branchDecisions.js';
import type { CheckResult } from './check.js';
import type { StackView } from './checkDecisions.js';
import { readFailed, readOk } from './readResult.js';

const request = { parent: 'parent', branch: 'child', trunk: 'main', remote: 'origin' };
const containing = (value: string): unknown => expect.stringContaining(value);
const anyReason: unknown = expect.any(String);
const evidence = { current: null, resolved: null, github: null };
const standalone: CheckResult = { result: 'standalone', branch: 'parent', evidence };
const unknown: CheckResult = { ...standalone, result: 'unknown', reason: 'parent check failed' };

const basedOn = (branch: string): CheckResult => ({
  ...standalone,
  result: 'tracked',
  trunk: 'main',
  parent: 'main',
  layers: [],
  basedOn: [{ branch, number: 1, url: 'https://github.com/sQVe/tau/pull/1' }],
});

it.each([
  { name: 'unknown parent check', check: unknown, result: 'stop' },
  { name: 'another branch based on parent', check: basedOn('other'), result: 'stop' },
  { name: 'new branch based on parent', check: basedOn('child'), result: 'proceed' },
  { name: 'standalone parent', check: standalone, result: 'proceed' },
])('decides parent guard for $name', ({ check, result }) => {
  expect(decideBranchParent(check, 'child')).toMatchObject({ result });
});

it.each([
  { code: 0, result: 'stacked' },
  { code: 2, result: 'unstacked' },
  { code: 1, result: 'stop' },
  { code: 6, result: 'stop' },
  { code: null, result: 'stop' },
])('decides checkout exit $code', ({ code, result }) => {
  const decision = decideBranchCheckout('gh stack checkout parent', {
    exitCode: code,
    stdout: '',
    stderr: 'checkout detail',
  });

  const expected =
    result === 'stop' ? { result, reason: containing('checkout detail') } : { result };

  expect(decision).toMatchObject(expected);
});

const view = (names: string[]): StackView => ({
  trunk: 'main',
  currentBranch: names.at(-1) ?? '',
  branches: names.map((name, index) => ({
    name,
    base: names[index - 1] ?? 'main',
    isCurrent: index === names.length - 1,
    isMerged: false,
    isQueued: false,
    needsRebase: false,
  })),
});

const viewCases: {
  name: string;
  read: StackView;
  phase: 'retry' | 'parent' | 'final';
  result: string;
  reason?: string;
}[] = [
  { name: 'parent at top', read: view(['parent']), phase: 'parent', result: 'add' },
  { name: 'branch above parent', read: view(['parent', 'other']), phase: 'parent', result: 'stop' },
  {
    name: 'parent missing',
    read: view(['other']),
    phase: 'parent',
    result: 'stop',
    reason: 'does not list parent parent',
  },
  {
    name: 'empty parent stack',
    read: view([]),
    phase: 'parent',
    result: 'stop',
    reason: 'does not list parent parent',
  },
  {
    name: 'retry already in place',
    read: view(['parent', 'child']),
    phase: 'retry',
    result: 'inPlace',
  },
  {
    name: 'retry branch elsewhere',
    read: view(['child']),
    phase: 'retry',
    result: 'checkoutParent',
  },
  {
    name: 'retry not at top',
    read: view(['parent', 'child', 'other']),
    phase: 'retry',
    result: 'stop',
  },
  { name: 'created at top', read: view(['parent', 'child']), phase: 'final', result: 'inPlace' },
  {
    name: 'final not at top',
    read: view(['parent', 'child', 'other']),
    phase: 'final',
    result: 'stop',
  },
  {
    name: 'final not adjacent',
    read: view(['parent', 'other', 'child']),
    phase: 'final',
    result: 'stop',
  },
  { name: 'final branch missing', read: view(['parent']), phase: 'final', result: 'stop' },
  { name: 'final parent missing', read: view(['child']), phase: 'final', result: 'stop' },
];

it.each(viewCases)('decides stack view for $name', ({ read, phase, result, reason }) => {
  const decision = decideBranchView(read, request, phase);

  const expectedReason = reason === undefined ? anyReason : containing(reason);
  const expected = result === 'stop' ? { result, reason: expectedReason } : { result };

  expect(decision).toMatchObject(expected);
});

it.each([
  { name: 'remote ahead', commits: readOk('commit'), direction: 'behind', result: 'fastForward' },
  { name: 'remote current', commits: readOk(''), direction: 'behind', result: 'ready' },
  { name: 'parent ahead', commits: readOk('commit'), direction: 'ahead', result: 'stop' },
  { name: 'parent current', commits: readOk(''), direction: 'ahead', result: 'ready' },
  {
    name: 'history read failed',
    commits: readFailed('git log', 'failed'),
    direction: 'ahead',
    result: 'stop',
  },
] as const)('decides parent history for $name', ({ commits, direction, result }) => {
  expect(decideParentHistory(commits, direction)).toMatchObject({ result });
});

it.each([
  { code: 0, result: 'done' },
  { code: 1, result: 'stop' },
  { code: 2, result: 'stop' },
  { code: null, result: 'stop' },
])('decides write exit $code', ({ code, result }) => {
  expect(
    decideBranchWrite('gh stack add child', {
      exitCode: code,
      stdout: '',
      stderr: 'write detail',
    }),
  ).toMatchObject({ result });
});

it('reports the command reason when fast-forward fails', () => {
  expect(
    decideBranchWrite('git merge --ff-only origin/parent', {
      exitCode: 128,
      stdout: '',
      stderr: 'Not possible to fast-forward',
    }),
  ).toEqual({
    result: 'stop',
    reason: 'git merge --ff-only origin/parent exited with code 128: Not possible to fast-forward',
  });
});
