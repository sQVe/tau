import { expect, it } from 'vitest';

import type { Repository } from '../../github.js';
import {
  pickBaseBranch,
  pickBaseRemote,
  pickBaseRepository,
  pickHead,
  pickPullRequests,
  pickPushRepository,
  rejectDefaultBranch,
  upstreamRepository,
} from './targetDecisions.js';
import type { HeadFacts, ListedPullRequest, PullRequest, Remote } from './targetDecisions.js';

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

const pushTarget = (name: string, trackingRef: string, remoteRef?: string) => ({
  remote: name,
  trackingRef,
  remoteRef,
});

const remotes: Remote[] = [
  remote('origin', fork, fork),
  remote('local', undefined, undefined),
  remote('upstream', { host: 'github.com', owner: 'sqve', name: 'Tau' }, undefined),
];

const headFacts = (facts: Partial<HeadFacts> = {}): HeadFacts => ({
  branch: 'feature',
  pushTarget: undefined,
  requestedRemote: undefined,
  remotes,
  remotesWithBranch: [],
  ...facts,
});

const cacheRemotes = [remote('origin', fork, fork, ['+refs/heads/*:refs/remotes/origin/cache/*'])];

const overlappingRemotes = [
  remote('origin', fork, fork, [
    '+refs/heads/*:refs/remotes/origin/*',
    '+refs/heads/team/*:refs/remotes/origin/*',
  ]),
];

it.each([
  {
    facts: headFacts({
      requestedRemote: 'upstream',
      pushTarget: pushTarget('origin', 'refs/remotes/origin/feature'),
    }),
    head: { remote: 'upstream', branch: 'feature' },
  },
  {
    facts: headFacts({
      pushTarget: pushTarget('origin', 'refs/remotes/origin/topic/feature'),
      remotesWithBranch: ['upstream'],
    }),
    head: { remote: 'origin', branch: 'topic/feature' },
  },
  {
    facts: headFacts({ remotesWithBranch: ['origin'] }),
    head: { remote: 'origin', branch: 'feature' },
  },
  {
    facts: headFacts({
      pushTarget: pushTarget('foo/bar', 'refs/remotes/foo/bar/feature'),
      remotes: [remote('foo', fork, fork), remote('foo/bar', upstream, upstream)],
    }),
    head: { remote: 'foo/bar', branch: 'feature' },
  },
  {
    facts: headFacts({
      pushTarget: pushTarget('origin', 'refs/remotes/origin/cache/feature'),
      remotes: cacheRemotes,
    }),
    head: { remote: 'origin', branch: 'feature' },
  },
  {
    facts: headFacts({
      pushTarget: pushTarget('origin', 'refs/remotes/origin/cache/other', 'refs/heads/other'),
      remotes: cacheRemotes,
    }),
    head: { remote: 'origin', branch: 'other' },
  },
  {
    facts: headFacts({
      pushTarget: pushTarget('origin', 'refs/remotes/origin/feature'),
      remotes: [
        remote('origin', fork, fork, [
          '^refs/heads/secret/*',
          'refs/tags/*:refs/tags/*',
          '+refs/heads/main:refs/remotes/origin/main',
          '+refs/heads/*:refs/remotes/origin/*',
        ]),
      ],
    }),
    head: { remote: 'origin', branch: 'feature' },
  },
  {
    facts: headFacts({
      pushTarget: pushTarget('origin', 'refs/remotes/origin/feature'),
      remotes: [
        remote('origin', fork, fork, ['+refs/heads/feature*:refs/remotes/origin/feature*']),
      ],
    }),
    head: { remote: 'origin', branch: 'feature' },
  },
  {
    facts: headFacts({
      pushTarget: pushTarget('origin', 'refs/remotes/origin/feature'),
      remotes: [
        remote('origin', fork, fork, [
          '+refs/heads/*/x/*:refs/remotes/origin/*',
          '+refs/heads/*:refs/remotes/origin/*',
        ]),
      ],
    }),
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
  {
    facts: headFacts({ pushTarget: pushTarget('gone', 'refs/remotes/gone/feature') }),
    error: 'Branch feature pushes to remote gone, which is not a Git remote of this checkout.',
  },
  {
    facts: headFacts({
      pushTarget: pushTarget('origin', 'refs/remotes/origin/team/feature'),
      remotes: overlappingRemotes,
    }),
    error:
      'Branch feature pushes to refs/remotes/origin/team/feature, which the fetch refspecs of origin map from several branches: team/feature, team/team/feature. Pass remote.',
  },
  {
    facts: headFacts({
      pushTarget: pushTarget('origin', 'refs/remotes/elsewhere/feature'),
      remotes: cacheRemotes,
    }),
    error:
      'Branch feature pushes to refs/remotes/elsewhere/feature, which no fetch refspec of origin maps from a branch. Pass remote.',
  },
  {
    facts: headFacts({
      pushTarget: pushTarget('origin', 'refs/remotes/origin/for/main', 'refs/for/main'),
    }),
    error: 'Branch feature pushes to refs/for/main on origin, which is not a branch.',
  },
])('refuses to pick a head: $error', ({ facts, error }) => {
  expect(() => pickHead(facts)).toThrow(error);
});

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

const push = (url: string, repository: Repository | undefined) => ({ url, repository });
const forkUrl = 'git@github.com:fork/tau.git';
const upstreamUrl = 'https://github.com/sQVe/tau.git';

it.each([
  { pushes: [push(forkUrl, fork)], repository: fork },
  {
    pushes: [push(forkUrl, fork), push('https://github.com/FORK/Tau', { ...fork, owner: 'FORK' })],
    repository: fork,
  },
])('pushes to one repository through $pushes.length URLs', ({ pushes, repository }) => {
  expect(pickPushRepository({ ...remote('origin', fork, fork), pushes })).toEqual(repository);
});

it.each([
  {
    pushes: [],
    error: 'Remote origin has no push URL.',
  },
  {
    pushes: [push('/srv/mirror.git', undefined)],
    error: 'The push URL of remote origin, /srv/mirror.git, does not name a GitHub repository.',
  },
  {
    pushes: [push(forkUrl, fork), push(upstreamUrl, upstream)],
    error:
      'Remote origin pushes to several repositories: github.com/fork/tau, github.com/sQVe/tau. Keep one push URL for it, or pass another remote.',
  },
])('refuses the push URLs of a remote: $error', ({ pushes, error }) => {
  expect(() => pickPushRepository({ ...remote('origin', fork, fork), pushes })).toThrow(error);
});
