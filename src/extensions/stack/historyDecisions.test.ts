import { expect, it } from 'vitest';

import {
  activeLayerParents,
  decideLayer,
  readAncestor,
  readCherry,
  readCommitCount,
  readRemoteTip,
  requireStackView,
} from './historyDecisions.js';
import type { CherryMark, HistoryLayer, PublishedReads } from './historyDecisions.js';
import { readFailed, readOk } from './readResult.js';
import type { CommandOutput } from './readResult.js';

const containing = (text: string): unknown => expect.stringContaining(text);

const output = (stdout: string, exitCode: number | null = 0, stderr = ''): CommandOutput => ({
  exitCode,
  stdout,
  stderr,
});

const layer = (name: string, flags: Partial<HistoryLayer> = {}): HistoryLayer => ({
  name,
  isMerged: false,
  isQueued: false,
  ...flags,
});

it.each([
  {
    name: 'the bottom branch',
    layers: [layer('a'), layer('b'), layer('c')],
    expected: [
      { branch: 'a', newParent: 'main', oldParent: 'main' },
      { branch: 'b', newParent: 'a', oldParent: 'a' },
      { branch: 'c', newParent: 'b', oldParent: 'b' },
    ],
  },
  {
    name: 'a merged branch below',
    layers: [layer('a', { isMerged: true }), layer('b'), layer('c')],
    expected: [
      { branch: 'b', newParent: 'main', oldParent: 'a' },
      { branch: 'c', newParent: 'b', oldParent: 'b' },
    ],
  },
  {
    name: 'two merged branches below',
    layers: [layer('a', { isMerged: true }), layer('b', { isMerged: true }), layer('c')],
    expected: [{ branch: 'c', newParent: 'main', oldParent: 'b' }],
  },
  {
    name: 'a merged branch between active ones',
    layers: [layer('a'), layer('b', { isMerged: true }), layer('c')],
    expected: [
      { branch: 'a', newParent: 'main', oldParent: 'main' },
      { branch: 'c', newParent: 'a', oldParent: 'b' },
    ],
  },
  {
    name: 'a queued branch, which is skipped but still a parent',
    layers: [layer('a'), layer('b', { isQueued: true }), layer('c')],
    expected: [
      { branch: 'a', newParent: 'main', oldParent: 'main' },
      { branch: 'c', newParent: 'b', oldParent: 'b' },
    ],
  },
  {
    name: 'only merged and queued branches',
    layers: [layer('a', { isMerged: true }), layer('b', { isQueued: true })],
    expected: [],
  },
  { name: 'no branches', layers: [], expected: [] },
])('finds the parents of the active branches for $name', ({ layers, expected }) => {
  expect(activeLayerParents('main', layers)).toEqual(expected);
});

const tip = 'c'.repeat(40);

it.each([
  { out: output(`${tip}\n`), expected: readOk(tip) },
  { out: output('', 1), expected: readOk(null) },
])('reads the remote tip from $out.exitCode', ({ out, expected }) => {
  expect(readRemoteTip('git rev-parse', out)).toEqual(expected);
});

it.each([
  { out: output('', 0), why: 'empty output with exit 0' },
  { out: output('not a sha\n'), why: 'a value that is not a SHA' },
  { out: output(`x${tip}\n`), why: 'text before the SHA' },
  { out: output(`${tip}x\n`), why: 'text after the SHA' },
  { out: output('', 128, 'fatal: bad'), why: 'exit 128' },
  { out: output('abc', 1), why: 'output with exit 1' },
  { out: output('', null), why: 'a command that did not finish' },
])('fails the remote tip read for $why', ({ out }) => {
  expect(readRemoteTip('git rev-parse', out)).toMatchObject({ ok: false });
});

it.each([
  { out: output(''), count: 0 },
  { out: output('abc1234 one\n'), count: 1 },
  { out: output('abc1234 one\ndef5678 two\n'), count: 2 },
])('counts $count commits', ({ out, count }) => {
  expect(readCommitCount('git log', out)).toEqual(readOk(count));
});

it('fails the commit count when git log fails', () => {
  expect(readCommitCount('git log', output('', 128, 'fatal: bad revision'))).toMatchObject({
    ok: false,
    problem: containing('bad revision'),
  });
});

it.each([
  { exitCode: 0, expected: readOk(true) },
  { exitCode: 1, expected: readOk(false) },
])('reads exit $exitCode of merge-base --is-ancestor', ({ exitCode, expected }) => {
  expect(readAncestor('git merge-base', output('', exitCode))).toEqual(expected);
});

it.each([128, null])('fails the ancestor read for exit %s', (exitCode) => {
  expect(readAncestor('git merge-base', output('', exitCode, 'fatal'))).toMatchObject({
    ok: false,
  });
});

it.each([
  { stdout: '', marks: [] },
  { stdout: '- abcdef0123\n', marks: ['-'] },
  { stdout: '- abcdef0123\n+ 0123456789ab\n', marks: ['-', '+'] },
])('reads cherry marks $marks', ({ stdout, marks }) => {
  expect(readCherry('git cherry', output(stdout))).toEqual(readOk(marks));
});

it.each([
  { out: output('abcdef0123\n'), why: 'a line without a mark' },
  { out: output('* abcdef0123\n'), why: 'an unknown mark' },
  { out: output('x- abcdef0123\n'), why: 'text before the mark' },
  { out: output('- not-a-sha\n'), why: 'a value that is not a SHA' },
  { out: output('- abcdef0123 subject\n'), why: 'a verbose line' },
  { out: output('', 128, 'fatal: unknown commit'), why: 'a failed command' },
])('fails the cherry read for $why', ({ out }) => {
  expect(readCherry('git cherry', out)).toMatchObject({ ok: false });
});

const published = (overrides: Partial<PublishedReads> = {}): PublishedReads => ({
  unseen: readOk(2),
  ancestor: readOk(false),
  newCherry: readOk(['-']),
  oldCherry: readOk(['-']),
  ...overrides,
});

const decide = (reads: PublishedReads) => decideLayer({ remoteTip: readOk(tip), published: reads });

it.each([
  {
    name: 'no remote branch',
    facts: { remoteTip: readOk(null), published: null },
    status: 'unpublished',
    tip: null,
  },
  {
    name: 'a remote with nothing new',
    facts: { remoteTip: readOk(tip), published: published({ unseen: readOk(0) }) },
    status: 'current',
    tip,
  },
  {
    name: 'a branch behind its remote',
    facts: { remoteTip: readOk(tip), published: published({ ancestor: readOk(true) }) },
    status: 'behind',
    tip,
  },
  {
    name: 'a rewritten remote',
    facts: { remoteTip: readOk(tip), published: published() },
    status: 'rewritten',
    tip,
  },
  {
    name: 'a rewritten remote with several commits',
    facts: {
      remoteTip: readOk(tip),
      published: published({ newCherry: readOk(['-', '-']), oldCherry: readOk(['-', '-', '-']) }),
    },
    status: 'rewritten',
    tip,
  },
])('decides $status for $name', ({ facts, status, tip: noted }) => {
  expect(decideLayer(facts)).toEqual({ status, remoteTip: noted, reason: null });
});

it.each([
  {
    name: 'a new commit on the remote',
    newCherry: ['-', '+'] as CherryMark[],
    oldCherry: ['-'] as CherryMark[],
  },
  {
    name: 'a local commit the remote lacks',
    newCherry: ['-'] as CherryMark[],
    oldCherry: ['+'] as CherryMark[],
  },
  {
    name: 'empty output from the first cherry',
    newCherry: [] as CherryMark[],
    oldCherry: ['-'] as CherryMark[],
  },
  {
    name: 'empty output from the second cherry',
    newCherry: ['-'] as CherryMark[],
    oldCherry: [] as CherryMark[],
  },
  {
    name: 'empty output from both cherries',
    newCherry: [] as CherryMark[],
    oldCherry: [] as CherryMark[],
  },
])('decides diverged for $name', ({ newCherry, oldCherry }) => {
  const decision = decide(
    published({ newCherry: readOk(newCherry), oldCherry: readOk(oldCherry) }),
  );

  expect(decision).toEqual({ status: 'diverged', remoteTip: tip, reason: null });
});

it('does not call a branch rebased since its push behind, even when it is an ancestor', () => {
  expect(decide(published({ ancestor: null })).status).toBe('rewritten');
});

it('decides diverged for a rebased branch whose remote has other commits', () => {
  const decision = decide(published({ ancestor: null, newCherry: readOk(['+']) }));

  expect(decision.status).toBe('diverged');
});

it('does not read the cherry output of a current branch', () => {
  const reads = published({
    unseen: readOk(0),
    newCherry: readFailed('git cherry', 'exited with code 128'),
  });

  expect(decide(reads).status).toBe('current');
});

it('does not read the cherry output of a branch that is behind', () => {
  const reads = published({
    ancestor: readOk(true),
    oldCherry: readFailed('git cherry', 'exited with code 128'),
  });

  expect(decide(reads).status).toBe('behind');
});

it.each([
  {
    name: 'the remote tip',
    facts: { remoteTip: readFailed('git rev-parse', 'bad'), published: null },
  },
  {
    name: 'the log',
    facts: {
      remoteTip: readOk(tip),
      published: published({ unseen: readFailed('git log', 'bad') }),
    },
  },
  {
    name: 'the ancestor test',
    facts: {
      remoteTip: readOk(tip),
      published: published({ ancestor: readFailed('git merge-base', 'bad') }),
    },
  },
  {
    name: 'the first cherry',
    facts: {
      remoteTip: readOk(tip),
      published: published({ newCherry: readFailed('git cherry', 'bad') }),
    },
  },
  {
    name: 'the second cherry',
    facts: {
      remoteTip: readOk(tip),
      published: published({ oldCherry: readFailed('git cherry', 'bad') }),
    },
  },
])('decides unknown, with the reason, when $name cannot be read', ({ facts }) => {
  expect(decideLayer(facts)).toMatchObject({
    status: 'unknown',
    reason: containing('bad'),
  });
});

it.each([
  { exitCode: 2, why: 'no stack' },
  { exitCode: 6, why: 'several stacks' },
  { exitCode: null, why: 'a command that did not finish' },
])('stops the history check for $why', ({ exitCode }) => {
  expect(requireStackView({ exitCode, view: null })).toMatchObject({ ok: false });
});

it('stops the history check when exit 0 printed nothing readable', () => {
  const view = readFailed('gh stack view --json', 'printed output that cannot be read: ');

  expect(requireStackView({ exitCode: 0, view })).toBe(view);
  expect(requireStackView({ exitCode: 0, view: null })).toMatchObject({ ok: false });
});

it('keeps the branches of a readable stack view', () => {
  const view = readOk({ trunk: 'main', currentBranch: 'a', branches: [] });

  expect(requireStackView({ exitCode: 0, view })).toBe(view);
});
