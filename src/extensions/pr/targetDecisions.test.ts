import { expect, it } from 'vitest';

import type { Repository } from '../../github/github.js';
import type { Remote } from '../../github/repositoryTargetDecisions.js';
import {
  pickBaseBranch,
  pickBaseRemote,
  pickPullRequests,
  rejectDefaultBranch,
} from './targetDecisions.js';
import type { ListedPullRequest, PullRequest } from './targetDecisions.js';

const upstream = { host: 'github.com', owner: 'sQVe', name: 'tau' };
const fork = { host: 'github.com', owner: 'fork', name: 'tau' };

const remote = (
  name: string,
  repository: Remote['repository'],
  pushRepository: Repository | undefined,
  fetchRefspecs = [`+refs/heads/*:refs/remotes/${name}/*`],
): Remote => ({
  name,
  repository,
  pushes: [{ url: `https://example.com/${name}.git`, repository: pushRepository }],
  fetchRefspecs,
});

const remotes: Remote[] = [
  remote('origin', fork, fork),
  remote('local', undefined, undefined),
  remote('upstream', { host: 'github.com', owner: 'sqve', name: 'Tau' }, undefined),
];

const sameFetchRemotes: Remote[] = [
  remote('mirror', upstream, upstream),
  remote('upstream', upstream, upstream),
];

const swappedRemotes: Remote[] = [
  remote('origin', fork, upstream),
  remote('upstream', upstream, upstream),
];

it.each([
  { remotes, head: 'origin', base: fork, remote: 'origin' },
  { remotes, head: 'origin', base: upstream, remote: 'upstream' },
  { remotes, head: 'local', base: upstream, remote: 'upstream' },
  { remotes: sameFetchRemotes, head: 'upstream', base: upstream, remote: 'upstream' },
  { remotes: sameFetchRemotes, head: 'origin', base: upstream, remote: 'mirror' },
  { remotes: swappedRemotes, head: 'origin', base: upstream, remote: 'upstream' },
])('fetches the base from $remote when the head remote is $head', (row) => {
  expect(pickBaseRemote(row.remotes, row.head, row.base)).toBe(row.remote);
});

it('refuses a base repository that no remote fetches from', () => {
  const pushOnly: Remote[] = [remote('origin', fork, upstream)];

  expect(() => pickBaseRemote(pushOnly, 'origin', upstream)).toThrow(
    'No Git remote fetches from github.com/sQVe/tau. Add one.',
  );
});

const listed = (
  number: number,
  state: string,
  owner = 'fork',
  name: string | null = 'tau',
): ListedPullRequest => ({
  number,
  url: `https://github.com/sQVe/tau/pull/${number}`,
  state,
  title: 'Title',
  body: 'Body',
  baseRefName: 'main',
  isDraft: false,
  headRefOid: 'abc123',
  headRepositoryOwner: { login: owner },
  headRepository: name === null ? null : { name },
});

const numbers = (prs: readonly PullRequest[]) => prs.map((pr) => pr.number);

it.each([
  { prs: [], pr: null, closed: [] },
  { prs: [listed(1, 'OPEN')], pr: 1, closed: [] },
  { prs: [listed(1, 'OPEN', 'FORK')], pr: 1, closed: [] },
  { prs: [listed(1, 'OPEN', 'someone')], pr: null, closed: [] },
  { prs: [listed(1, 'OPEN', 'fork', 'TAU')], pr: 1, closed: [] },
  { prs: [listed(1, 'OPEN', 'fork', 'project')], pr: null, closed: [] },
  { prs: [listed(1, 'MERGED', 'fork', null)], pr: null, closed: [] },
  { prs: [listed(1, 'OPEN', 'fork', 'project'), listed(2, 'OPEN')], pr: 2, closed: [] },
  { prs: [listed(1, 'MERGED'), listed(2, 'CLOSED')], pr: null, closed: [1, 2] },
  { prs: [listed(1, 'CLOSED'), listed(2, 'OPEN'), listed(3, 'OPEN', 'x')], pr: 2, closed: [1] },
])('picks pull request $pr and closed $closed', ({ prs, pr, closed }) => {
  const choice = pickPullRequests(prs, fork);

  expect(choice.pr?.number ?? null).toBe(pr);
  expect(numbers(choice.closedPrs)).toEqual(closed);
});

it('refuses several open pull requests for one branch', () => {
  expect(() => pickPullRequests([listed(1, 'OPEN'), listed(2, 'OPEN')], fork)).toThrow(
    'Pull requests #1, #2 are all open for this branch.',
  );
});

const openPr = { ...listed(1, 'OPEN'), baseRefName: 'release' };

it('bases an open pull request on the requested base instead of its current base', () => {
  expect(pickBaseBranch({ pr: openPr, requestedBase: 'develop', defaultBranch: 'main' })).toBe(
    'develop',
  );
});

it.each([
  { pr: openPr, requestedBase: undefined, branch: 'release' },
  { pr: null, requestedBase: 'develop', branch: 'develop' },
  { pr: null, requestedBase: undefined, branch: 'main' },
])('bases the branch on $branch', ({ pr, requestedBase, branch }) => {
  expect(pickBaseBranch({ pr, requestedBase, defaultBranch: 'main' })).toBe(branch);
});

const branches = (localBranch: string, pushBranch: string) => ({
  localBranch,
  pushBranch,
  headRepository: fork,
  defaultBranch: 'trunk',
});

it.each([
  { facts: branches('feature', 'feature') },
  { facts: branches('main', 'main') },
  { facts: branches('work', 'feature') },
])('accepts $facts.localBranch pushing to $facts.pushBranch', ({ facts }) => {
  expect(() => {
    rejectDefaultBranch(facts);
  }).not.toThrow();
});

it.each([
  {
    facts: branches('trunk', 'trunk'),
    error: 'trunk is the default branch of github.com/fork/tau. Check out a feature branch.',
  },
  {
    facts: branches('trunk', 'feature'),
    error: 'trunk is the default branch of github.com/fork/tau. Check out a feature branch.',
  },
  {
    facts: branches('work', 'trunk'),
    error:
      'work pushes to trunk, the default branch of github.com/fork/tau. Push to a feature branch.',
  },
])('refuses $facts.localBranch pushing to $facts.pushBranch', ({ facts, error }) => {
  expect(() => {
    rejectDefaultBranch(facts);
  }).toThrow(error);
});
