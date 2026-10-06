import { expect, it } from 'vitest';

import {
  pickBaseBranch,
  pickBaseRemote,
  pickBaseRepository,
  pickHead,
  pickPullRequests,
  upstreamRepository,
} from './targetDecisions.js';
import type { HeadFacts, ListedPullRequest, PullRequest, Remote } from './targetDecisions.js';

const upstream = { host: 'github.com', owner: 'sQVe', name: 'tau' };
const fork = { host: 'github.com', owner: 'fork', name: 'tau' };

const remotes: Remote[] = [
  { name: 'origin', repository: fork, pushRepository: fork },
  { name: 'local', repository: undefined, pushRepository: undefined },
  {
    name: 'upstream',
    repository: { host: 'github.com', owner: 'sqve', name: 'Tau' },
    pushRepository: undefined,
  },
];

const headFacts = (facts: Partial<HeadFacts> = {}): HeadFacts => ({
  branch: 'feature',
  pushTarget: undefined,
  requestedRemote: undefined,
  remotes,
  remotesWithBranch: [],
  ...facts,
});

it.each([
  {
    facts: headFacts({ requestedRemote: 'upstream', pushTarget: 'origin/feature' }),
    head: { remote: 'upstream', branch: 'feature' },
  },
  {
    facts: headFacts({ pushTarget: 'origin/topic/feature', remotesWithBranch: ['upstream'] }),
    head: { remote: 'origin', branch: 'topic/feature' },
  },
  {
    facts: headFacts({ pushTarget: 'gone/feature', remotesWithBranch: ['upstream'] }),
    head: { remote: 'upstream', branch: 'feature' },
  },
  {
    facts: headFacts({ remotesWithBranch: ['origin'] }),
    head: { remote: 'origin', branch: 'feature' },
  },
])('picks the head $head.remote/$head.branch', ({ facts, head }) => {
  expect(pickHead(facts)).toEqual(head);
});

it.each([
  { facts: headFacts({ requestedRemote: 'nowhere' }), error: 'remote nowhere is not a Git remote' },
  { facts: headFacts(), error: 'no remote has a branch named feature. Pass remote.' },
  {
    facts: headFacts({ remotesWithBranch: ['origin', 'upstream'] }),
    error: 'Remotes origin, upstream all have a branch named feature. Pass remote.',
  },
])('refuses to pick a head: $error', ({ facts, error }) => {
  expect(() => pickHead(facts)).toThrow(error);
});

it.each([
  { head: { remote: 'origin', repository: fork }, base: fork, remote: 'origin' },
  { head: { remote: 'origin', repository: fork }, base: upstream, remote: 'upstream' },
  { head: { remote: 'mine', repository: upstream }, base: upstream, remote: 'mine' },
])('fetches the base from $remote', ({ head, base, remote }) => {
  expect(pickBaseRemote(remotes, head, base)).toBe(remote);
});

it('refuses a fork whose upstream has no Git remote', () => {
  const head = { remote: 'origin', repository: fork };

  expect(() => pickBaseRemote(remotes.slice(0, 2), head, upstream)).toThrow(
    'No Git remote points at github.com/sQVe/tau, the upstream of github.com/fork/tau.',
  );
});

const listed = (number: number, state: string, owner = 'fork'): ListedPullRequest => ({
  number,
  url: `https://github.com/sQVe/tau/pull/${number}`,
  state,
  title: 'Title',
  body: 'Body',
  baseRefName: 'main',
  isDraft: false,
  headRefOid: 'abc123',
  headRepositoryOwner: { login: owner },
});

const numbers = (prs: readonly PullRequest[]) => prs.map((pr) => pr.number);

it.each([
  { prs: [], pr: null, closed: [] },
  { prs: [listed(1, 'OPEN')], pr: 1, closed: [] },
  { prs: [listed(1, 'OPEN', 'FORK')], pr: 1, closed: [] },
  { prs: [listed(1, 'OPEN', 'someone')], pr: null, closed: [] },
  { prs: [listed(1, 'MERGED'), listed(2, 'CLOSED')], pr: null, closed: [1, 2] },
  { prs: [listed(1, 'CLOSED'), listed(2, 'OPEN'), listed(3, 'OPEN', 'x')], pr: 2, closed: [1] },
])('picks pull request $pr and closed $closed', ({ prs, pr, closed }) => {
  const choice = pickPullRequests(prs, 'fork');

  expect(choice.pr?.number ?? null).toBe(pr);
  expect(numbers(choice.closedPrs)).toEqual(closed);
});

it('refuses several open pull requests for one branch', () => {
  expect(() => pickPullRequests([listed(1, 'OPEN'), listed(2, 'OPEN')], 'fork')).toThrow(
    'Pull requests #1, #2 are all open for this branch.',
  );
});

const openPr = { ...listed(1, 'OPEN'), baseRefName: 'release' };

it.each([
  { pr: openPr, requestedBase: 'develop', branch: 'release' },
  { pr: null, requestedBase: 'develop', branch: 'develop' },
  { pr: null, requestedBase: undefined, branch: 'main' },
])('bases the branch on $branch', ({ pr, requestedBase, branch }) => {
  expect(pickBaseBranch({ pr, requestedBase, defaultBranch: 'main' })).toBe(branch);
});

const enterprise = { host: 'git.example.com:8443', owner: 'team', name: 'tau' };

it.each([
  { head: upstream, parent: null, upstream: undefined },
  { head: fork, parent: { owner: 'sQVe', name: 'tau' }, upstream },
  {
    head: enterprise,
    parent: { owner: 'core', name: 'tau' },
    upstream: { host: 'git.example.com:8443', owner: 'core', name: 'tau' },
  },
])('reads the upstream of $head.owner/$head.name as $upstream.owner', (row) => {
  expect(upstreamRepository(row.head, { parent: row.parent, defaultBranch: 'main' })).toEqual(
    row.upstream,
  );
});

const headView = { repository: fork, view: { parent: null, defaultBranch: 'trunk' } };
const upstreamView = { repository: upstream, view: { parent: null, defaultBranch: 'main' } };

it.each([
  { upstream: undefined, base: { repository: fork, defaultBranch: 'trunk' } },
  { upstream: upstreamView, base: { repository: upstream, defaultBranch: 'main' } },
])('bases the pull request on $base.repository.owner/$base.defaultBranch', (row) => {
  expect(pickBaseRepository(headView, row.upstream)).toEqual(row.base);
});
