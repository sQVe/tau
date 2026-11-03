import { expect, it } from 'vitest';

import type { Repository } from '../../github/github.js';
import {
  decideGithub,
  needsBasePull,
  normalizeGithubFacts,
  selectHeadPull,
} from './checkDecisions.js';
import type {
  BasedPull,
  DecisionFacts,
  GithubFacts,
  HeadPull,
  HeadPullChoice,
} from './checkDecisions.js';
import { readFailed, readOk } from './readResult.js';
import type { Read } from './readResult.js';

const containing = (text: string): unknown => expect.stringContaining(text);

const pushRepository: Repository = { host: 'github.com', owner: 'fork', name: 'tau' };
const baseRepository: Repository = { host: 'github.com', owner: 'sQVe', name: 'tau' };

const headPull = (number: number, owner = 'fork', name: string | null = 'tau'): HeadPull => ({
  number,
  url: `https://github.com/sQVe/tau/pull/${number}`,
  baseRefName: 'main',
  headRepositoryOwner: { login: owner },
  headRepository: name === null ? null : { name },
});

it.each([
  { listed: [], expected: { kind: 'none' } },
  { listed: [headPull(1, 'other')], expected: { kind: 'none' } },
  { listed: [headPull(1, 'fork', 'other')], expected: { kind: 'none' } },
  { listed: [headPull(1, 'fork', null)], expected: { kind: 'none' } },
  {
    listed: [headPull(1, 'FORK', 'TAU')],
    expected: { kind: 'one', pull: headPull(1, 'FORK', 'TAU') },
  },
  { listed: [headPull(1, 'other'), headPull(2)], expected: { kind: 'one', pull: headPull(2) } },
  { listed: [headPull(1), headPull(2)], expected: { kind: 'several', numbers: [1, 2] } },
])(
  'selects the head pull request from $listed.length listed: $expected.kind',
  ({ listed, expected }) => {
    expect(selectHeadPull(listed, pushRepository)).toEqual(expected);
  },
);

it.each([
  { baseRefName: 'main', needs: false },
  { baseRefName: 'feature', needs: true },
])(
  'reads the base pull request: $needs when the base is $baseRefName',
  ({ baseRefName, needs }) => {
    expect(needsBasePull({ ...headPull(1), baseRefName }, 'main')).toBe(needs);
  },
);

const basedOn = (number: number, headRefName: string): BasedPull => ({
  number,
  url: `https://github.com/sQVe/tau/pull/${number}`,
  headRefName,
});

const facts = (overrides: Partial<GithubFacts> = {}): GithubFacts => ({
  defaultBranch: 'main',
  pushRepository,
  baseRepository,
  headPulls: readOk([headPull(5)]),
  basedOn: readOk([]),
  stacks: readOk({ kind: 'none' }),
  basePulls: null,
  ...overrides,
});

const onePull = (pull: HeadPull = headPull(5)): Read<HeadPullChoice> =>
  readOk<HeadPullChoice>({ kind: 'one', pull });

const decisionFacts = (overrides: Partial<DecisionFacts> = {}): DecisionFacts => ({
  headPull: { kind: 'one', pull: headPull(5) },
  basedOn: [],
  stacks: { kind: 'none' },
  basePulls: [],
  ...overrides,
});

it('reports a failed stacks read as unknown with its command, while one head pull request is open', () => {
  const outcome = normalizeGithubFacts(
    facts({ stacks: readFailed('gh api', 'exited with code 1') }),
    onePull(),
  );

  expect(outcome).toEqual({ result: 'unknown', reason: containing('gh api') });
});

it.each([
  {
    name: 'the head pull requests',
    given: facts({ headPulls: readFailed('gh pr list', 'exited with code 1') }),
    headPull: readFailed('gh pr list', 'exited with code 1'),
    command: 'gh pr list',
  },
  {
    name: 'the pull requests based on the branch',
    given: facts({ basedOn: readFailed('gh pr list', 'boom') }),
    headPull: onePull(),
    command: 'gh pr list',
  },
  {
    name: 'the base pull requests',
    given: facts({ basePulls: readFailed('gh pr list --head parent', 'boom') }),
    headPull: onePull(),
    command: 'gh pr list --head parent',
  },
])(
  'reports unknown, never standalone, when $name cannot be read',
  ({ given, headPull: choice, command }) => {
    expect(normalizeGithubFacts(given, choice)).toEqual({
      result: 'unknown',
      reason: containing(command),
    });
  },
);

it('reports unknown when a read failed even though a stack holds the pull request', () => {
  const outcome = normalizeGithubFacts(
    facts({
      stacks: readOk({ kind: 'stack', number: 40, pullRequests: [5] }),
      basedOn: readFailed('gh pr list --base', 'boom'),
    }),
    onePull(),
  );

  expect(outcome).toMatchObject({ result: 'unknown', reason: containing('boom') });
});

it.each([
  {
    name: 'one head pull request and no stacks read',
    given: facts({ stacks: null }),
    headPull: onePull(),
    reason: containing('stacks read for #5 was not made'),
  },
  {
    name: 'a non-default base and no base pull requests read',
    given: facts({
      headPulls: readOk([{ ...headPull(5), baseRefName: 'feature' }]),
      basePulls: null,
    }),
    headPull: onePull({ ...headPull(5), baseRefName: 'feature' }),
    reason: containing('base pull requests read for feature was not made'),
  },
])('reports unknown, never standalone, when $name', ({ given, headPull: choice, reason }) => {
  expect(normalizeGithubFacts(given, choice)).toEqual({ result: 'unknown', reason });
});

it.each([
  {
    name: 'no pull request holds the branch',
    given: facts({ headPulls: readOk([]), stacks: null }),
    headPull: readOk<HeadPullChoice>({ kind: 'none' }),
    expected: decisionFacts({ headPull: { kind: 'none' }, stacks: null }),
  },
  {
    name: 'a base pull request from a fork of the base repository',
    given: facts({
      headPulls: readOk([{ ...headPull(5), baseRefName: 'feature' }]),
      basePulls: readOk([headPull(4, 'someone')]),
    }),
    headPull: onePull({ ...headPull(5), baseRefName: 'feature' }),
    expected: decisionFacts({
      headPull: { kind: 'one', pull: { ...headPull(5), baseRefName: 'feature' } },
      basePulls: [],
    }),
  },
  {
    name: 'a base pull request that is gone',
    given: facts({ basePulls: readOk([]) }),
    headPull: onePull({ ...headPull(5), baseRefName: 'feature' }),
    expected: decisionFacts({
      headPull: { kind: 'one', pull: { ...headPull(5), baseRefName: 'feature' } },
    }),
  },
  {
    name: 'stacked pull requests turned off',
    given: facts({ stacks: readOk({ kind: 'off' }) }),
    headPull: onePull(),
    expected: decisionFacts({ stacks: { kind: 'off' } }),
  },
  {
    name: 'a GitHub stack that holds the branch',
    given: facts({ stacks: readOk({ kind: 'stack', number: 40, pullRequests: [4, 5, 6] }) }),
    headPull: onePull(),
    expected: decisionFacts({ stacks: { kind: 'stack', number: 40, pullRequests: [4, 5, 6] } }),
  },
  {
    name: 'several open pull requests, passed on as a choice',
    given: facts({ headPulls: readOk([headPull(5), headPull(7)]), stacks: null }),
    headPull: readOk<HeadPullChoice>({ kind: 'several', numbers: [5, 7] }),
    expected: decisionFacts({ headPull: { kind: 'several', numbers: [5, 7] }, stacks: null }),
  },
])('normalizes the reads for $name', ({ given, headPull: choice, expected }) => {
  expect(normalizeGithubFacts(given, choice)).toEqual({ result: 'facts', facts: expected });
});

it.each([
  {
    name: 'a pull request that nothing touches',
    facts: decisionFacts(),
  },
  {
    name: 'stacked pull requests turned off',
    facts: decisionFacts({ stacks: { kind: 'off' } }),
  },
  {
    name: 'no pull request at all',
    facts: decisionFacts({ headPull: { kind: 'none' }, stacks: null }),
  },
  {
    name: 'a base pull request that is gone',
    facts: decisionFacts({
      headPull: { kind: 'one', pull: { ...headPull(5), baseRefName: 'feature' } },
      basePulls: [],
    }),
  },
])('decides standalone for $name', ({ facts: given }) => {
  expect(decideGithub('feature', given)).toEqual({ result: 'standalone' });
});

it('decides untracked when a GitHub stack holds the pull request', () => {
  const decision = decideGithub(
    'feature',
    decisionFacts({ stacks: { kind: 'stack', number: 40, pullRequests: [4, 5, 6] } }),
  );

  expect(decision).toMatchObject({
    result: 'untracked',
    held: ['githubStack'],
    githubStack: { number: 40, pullRequests: [4, 5, 6] },
    chainBase: 'main',
  });
});

it('decides untracked when the base has an open pull request, and lists the chain', () => {
  const decision = decideGithub(
    'feature',
    decisionFacts({
      headPull: { kind: 'one', pull: { ...headPull(5), baseRefName: 'parent' } },
      basePulls: [{ ...headPull(4, 'sQVe'), baseRefName: 'main' }],
    }),
  );

  expect(decision).toEqual({
    result: 'untracked',
    held: ['baseHasOpenPull'],
    chain: [
      { branch: 'parent', number: 4, url: 'https://github.com/sQVe/tau/pull/4' },
      { branch: 'feature', number: 5, url: 'https://github.com/sQVe/tau/pull/5' },
    ],
    basedOn: [],
    chainBase: 'main',
    githubStack: null,
  });
});

it('decides untracked when an open pull request is based on the branch', () => {
  const decision = decideGithub('feature', decisionFacts({ basedOn: [basedOn(6, 'child')] }));

  expect(decision).toMatchObject({
    result: 'untracked',
    held: ['openPullBasedOnBranch'],
    basedOn: [{ branch: 'child', number: 6 }],
    chainBase: 'main',
  });
});

it('decides untracked for a branch without a pull request that others are based on', () => {
  const decision = decideGithub(
    'feature',
    decisionFacts({ headPull: { kind: 'none' }, stacks: null, basedOn: [basedOn(6, 'child')] }),
  );

  expect(decision).toMatchObject({
    result: 'untracked',
    chain: [{ branch: 'child', number: 6 }],
    chainBase: null,
  });
});

it('lists every reason that holds', () => {
  const decision = decideGithub(
    'feature',
    decisionFacts({
      headPull: { kind: 'one', pull: { ...headPull(5), baseRefName: 'parent' } },
      basedOn: [basedOn(6, 'child')],
      stacks: { kind: 'stack', number: 40, pullRequests: [4, 5, 6] },
      basePulls: [headPull(4, 'sQVe')],
    }),
  );

  expect(decision).toMatchObject({
    held: ['githubStack', 'baseHasOpenPull', 'openPullBasedOnBranch'],
  });
});

it('decides unknown for several open pull requests', () => {
  const decision = decideGithub(
    'feature',
    decisionFacts({ headPull: { kind: 'several', numbers: [5, 7] }, stacks: null }),
  );

  expect(decision).toMatchObject({
    result: 'unknown',
    reason: containing('#5, #7'),
  });
});
