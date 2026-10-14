import { expect, it } from 'vitest';

import { decideChain, parsePullRequestUrl, pickParent } from './chainDecisions.js';
import type { BlockerFacts, ChainFacts, Parent, PullView } from './chainDecisions.js';
import type { StackedPullRequests } from './checkDecisions.js';
import { readFailed, readOk } from './readResult.js';

const containing = (text: string): unknown => expect.stringContaining(text);

const url = (number: number) => `https://github.com/sQVe/tau/pull/${number}`;

const view = (number: number, state = 'OPEN'): PullView => ({
  number,
  headRefName: `slice-${number}`,
  baseRefName: 'main',
  state,
});

const blocker = (number: number, stacks?: StackedPullRequests, state = 'OPEN'): BlockerFacts => ({
  url: url(number),
  number,
  view: readOk(view(number, state)),
  stacks: readOk(stacks ?? { kind: 'none' }),
});

const stack = (...pullRequests: number[]): StackedPullRequests => ({
  kind: 'stack',
  number: 100,
  pullRequests,
});

it.each([
  { input: url(7), expected: { host: 'github.com', owner: 'sQVe', name: 'tau', number: 7 } },
  {
    input: `${url(7)}/files`,
    expected: { host: 'github.com', owner: 'sQVe', name: 'tau', number: 7 },
  },
  {
    input: 'https://git.example.com:8443/team/tau.js/pull/12',
    expected: { host: 'git.example.com:8443', owner: 'team', name: 'tau.js', number: 12 },
  },
  { input: 'https://github.com/sQVe/tau/issues/7', expected: undefined },
  { input: 'https://github.com/sQVe/tau/pull/seven', expected: undefined },
  { input: 'https://github.com/sQVe/pull/7', expected: undefined },
  { input: 'git@github.com:sQVe/tau.git', expected: undefined },
  { input: '', expected: undefined },
])('parses the pull request URL $input', ({ input, expected }) => {
  expect(parsePullRequestUrl(input)).toEqual(expected);
});

it('takes the only open blocker as the parent, whether or not a stack holds it', () => {
  expect(pickParent([blocker(3)])).toEqual({
    result: 'parent',
    parent: { number: 3, url: url(3), branch: 'slice-3', stack: null },
  });

  expect(pickParent([blocker(3, stack(2, 3, 4))])).toMatchObject({
    parent: { number: 3, stack: { number: 100, pullRequests: [2, 3, 4] } },
  });
});

it.each([
  { blockers: [blocker(2, stack(2, 3, 4)), blocker(3, stack(2, 3, 4))], parent: 3 },
  { blockers: [blocker(3, stack(2, 3, 4)), blocker(2, stack(2, 3, 4))], parent: 3 },
  { blockers: [blocker(2, stack(2, 3, 4)), blocker(4, stack(2, 3, 4))], parent: 4 },
  {
    blockers: [blocker(4, stack(2, 3, 4)), blocker(2, stack(2, 3, 4)), blocker(3, stack(2, 3, 4))],
    parent: 4,
  },
])('picks the open blocker highest in the stack: #$parent', ({ blockers, parent }) => {
  expect(pickParent(blockers)).toMatchObject({ result: 'parent', parent: { number: parent } });
});

it.each([
  {
    name: 'in different stacks',
    blockers: [blocker(2, stack(1, 2)), blocker(5, stack(5, 6))],
    reason: 'different',
  },
  {
    name: 'in a stack that holds only one of them',
    blockers: [blocker(2, stack(1, 2)), blocker(5, stack(5, 6, 2))],
    reason: 'different',
  },
  {
    name: 'in a stack with only one of them',
    blockers: [blocker(2, stack(2, 3)), blocker(5)],
    reason: 'different',
  },
  { name: 'in no stack', blockers: [blocker(2), blocker(5)], reason: 'no GitHub stack' },
  {
    name: 'with stacked pull requests off',
    blockers: [blocker(2, { kind: 'off' }), blocker(5, { kind: 'off' })],
    reason: 'no GitHub stack',
  },
])('stops when several open blockers are $name', ({ blockers, reason }) => {
  expect(pickParent(blockers)).toMatchObject({
    result: 'stop',
    reason: containing(reason),
  });
});

it.each([
  {
    name: 'the view',
    blocker: { ...blocker(2), view: readFailed('gh pr view', 'exited with code 1') },
  },
  {
    name: 'the stacks API',
    blocker: { ...blocker(2), stacks: readFailed('gh api', 'exited with code 1') },
  },
])('stops when $name of a blocker cannot be read', ({ blocker: failed }) => {
  expect(pickParent([blocker(3), failed])).toMatchObject({ result: 'stop' });
});

it('stops for a failed read of the only blocker', () => {
  const failed = { ...blocker(2), stacks: readFailed('gh api', 'HTTP 500') };

  expect(pickParent([failed])).toMatchObject({
    result: 'stop',
    reason: containing('HTTP 500'),
  });
});

it('stops for a blocker that is not open', () => {
  expect(pickParent([blocker(2, { kind: 'none' }, 'MERGED')])).toMatchObject({
    result: 'stop',
    reason: containing('#2'),
  });
});

it('stops without blockers', () => {
  expect(pickParent([])).toMatchObject({ result: 'stop' });
});

const parent = (stackNumbers: number[] | null, number = 3): Parent => ({
  number,
  url: url(number),
  branch: `slice-${number}`,
  stack: stackNumbers === null ? null : { number: 100, pullRequests: stackNumbers },
});

const chainFacts = (overrides: Partial<ChainFacts> = {}): ChainFacts => ({
  parent: parent(null),
  slicePullRequest: null,
  basedOn: readOk([]),
  stackEnds: null,
  defaultBranch: readOk('main'),
  ...overrides,
});

const ends = (bottomBase: string, topNumber: number) =>
  readOk({
    bottom: { ...view(2), baseRefName: bottomBase },
    top: view(topNumber),
  });

it('starts on the default branch when the parent has no stack and nothing above it', () => {
  expect(decideChain(chainFacts())).toEqual({
    result: 'parent',
    parent: { number: 3, url: url(3), branch: 'slice-3' },
    branchAbove: false,
    above: [],
    githubStack: null,
    trunk: 'main',
  });
});

it('takes the trunk from the bottom pull request of the parent stack', () => {
  const decision = decideChain(
    chainFacts({ parent: parent([2, 3]), stackEnds: ends('release', 3) }),
  );

  expect(decision).toMatchObject({
    branchAbove: false,
    above: [],
    githubStack: { number: 100, pullRequests: [2, 3], topBranch: 'slice-3', topPullRequest: 3 },
    trunk: 'release',
  });
});

it.each([
  { name: 'the top', stackNumbers: [2, 3], above: [] },
  { name: 'the bottom of three', stackNumbers: [3, 4, 5], above: [4, 5] },
  { name: 'the middle', stackNumbers: [2, 3, 4], above: [4] },
])('finds the pull requests above a parent in $name of its stack', ({ stackNumbers, above }) => {
  const decision = decideChain(
    chainFacts({ parent: parent(stackNumbers), stackEnds: ends('main', stackNumbers.at(-1) ?? 0) }),
  );

  expect(decision).toMatchObject({ branchAbove: above.length > 0, above });
});

it('finds a branch above the parent from an open pull request based on it', () => {
  const decision = decideChain(
    chainFacts({
      parent: parent([2, 3]),
      basedOn: readOk([{ number: 9, headRefName: 'other' }]),
      stackEnds: ends('main', 3),
    }),
  );

  expect(decision).toMatchObject({ result: 'parent', branchAbove: true, above: [9] });
});

it('does not count the pull request of the slice as a branch above', () => {
  const decision = decideChain(
    chainFacts({
      parent: parent([2, 3, 8]),
      slicePullRequest: 8,
      basedOn: readOk([{ number: 8, headRefName: 'slice' }]),
      stackEnds: ends('main', 8),
    }),
  );

  expect(decision).toMatchObject({ result: 'parent', branchAbove: false, above: [] });
});

it('counts a pull request based on the parent twice only once', () => {
  const decision = decideChain(
    chainFacts({
      parent: parent([2, 3, 4]),
      basedOn: readOk([{ number: 4, headRefName: 'child' }]),
      stackEnds: ends('main', 4),
    }),
  );

  expect(decision).toMatchObject({ above: [4] });
});

it('stops when a pull request is based on the parent and no stack holds the parent', () => {
  const decision = decideChain(
    chainFacts({ basedOn: readOk([{ number: 9, headRefName: 'other' }]) }),
  );

  expect(decision).toMatchObject({ result: 'stop', reason: containing('#9') });
});

it('stops when the parent stack does not list the parent', () => {
  const decision = decideChain(chainFacts({ parent: parent([4, 5]), stackEnds: ends('main', 5) }));

  expect(decision.result).toBe('stop');
});

it.each([
  {
    name: 'the pull requests based on the parent',
    facts: { basedOn: readFailed('gh pr list', 'boom') },
  },
  { name: 'the default branch', facts: { defaultBranch: readFailed('gh repo view', 'boom') } },
  {
    name: 'the ends of the stack',
    facts: { parent: parent([2, 3]), stackEnds: readFailed('gh pr view', 'boom') },
  },
])('stops when $name cannot be read', ({ facts }) => {
  expect(decideChain(chainFacts(facts))).toMatchObject({
    result: 'stop',
    reason: containing('boom'),
  });
});

it('stops when the parent has a stack but its ends were not read', () => {
  expect(decideChain(chainFacts({ parent: parent([2, 3]) })).result).toBe('stop');
});
