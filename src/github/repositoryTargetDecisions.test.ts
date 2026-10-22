import { expect, it } from 'vitest';

import type { Repository } from './github.js';
import {
  configRepositoryKey,
  parseRemoteUrl,
  pickBaseRepository,
  pickHead,
  pickPushRepository,
  upstreamRepository,
} from './repositoryTargetDecisions.js';
import type { HeadFacts, Remote, RemoteLocation } from './repositoryTargetDecisions.js';

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

const refspecHead = (trackingRef: string, ...fetchRefspecs: string[]) =>
  headFacts({
    pushTarget: pushTarget('origin', trackingRef),
    remotes: [remote('origin', fork, fork, fetchRefspecs)],
  });

it.each([
  {
    name: 'an exact refspec',
    facts: refspecHead('refs/remotes/origin/main', 'refs/heads/trunk:refs/remotes/origin/main'),
    branch: 'trunk',
  },
  {
    name: 'a suffix pattern',
    facts: refspecHead('refs/remotes/origin/feature-x', 'refs/heads/*:refs/remotes/origin/*-x'),
    branch: 'feature',
  },
  {
    name: 'a plus sign inside a ref',
    facts: refspecHead('refs/remotes/origin/c++/x', 'refs/heads/c++/*:refs/remotes/origin/c++/*'),
    branch: 'c++/x',
  },
])('maps the tracking ref back through $name', ({ facts, branch }) => {
  expect(pickHead(facts)).toEqual({ remote: 'origin', branch });
});

it.each([
  {
    name: 'an exact refspec for another ref',
    facts: refspecHead('refs/remotes/origin/other', 'refs/heads/trunk:refs/remotes/origin/main'),
  },
  {
    name: 'a suffix the ref does not end with',
    facts: refspecHead('refs/remotes/origin/feature', 'refs/heads/*:refs/remotes/origin/*-x'),
  },
  {
    name: 'a prefix and suffix that overlap in the ref',
    facts: refspecHead('refs/remotes/origin/a', 'refs/heads/*:refs/remotes/origin/a*a'),
  },
  {
    name: 'a refspec without a destination',
    facts: refspecHead('refs/remotes/origin/main', 'refs/heads/main'),
  },
])('finds no fetch refspec that maps $name', ({ facts }) => {
  expect(() => pickHead(facts)).toThrow('no fetch refspec of origin maps from a branch');
});

it.each<{ url: string; location: RemoteLocation | undefined }>([
  {
    url: 'git@github.com:sQVe/tau.git',
    location: {
      host: 'github.com',
      path: 'sQVe/tau.git',
      ssh: { host: 'github.com', user: 'git', port: '' },
    },
  },
  {
    url: 'github.com:sQVe/tau',
    location: {
      host: 'github.com',
      path: 'sQVe/tau',
      ssh: { host: 'github.com', user: '', port: '' },
    },
  },
  {
    url: 'ssh://git@github.com:22/sQVe/tau',
    location: {
      host: 'github.com',
      path: 'sQVe/tau',
      ssh: { host: 'github.com', user: 'git', port: '22' },
    },
  },
  {
    url: 'https://user:token@github.com/sQVe/tau.git',
    location: { host: 'github.com', path: 'sQVe/tau.git', ssh: undefined },
  },
  {
    url: 'https://github.com:8443/sQVe/tau/',
    location: { host: 'github.com:8443', path: 'sQVe/tau/', ssh: undefined },
  },
  { url: '/srv/sQVe/tau.git', location: undefined },
  { url: '../tau', location: undefined },
  { url: '', location: undefined },
])('parses the remote URL $url', ({ url, location }) => {
  expect(parseRemoteUrl(url)).toEqual(location);
});

it.each([
  { host: 'github.com', key: 'sQVe/tau' },
  { host: 'GitHub.com', key: 'sQVe/tau' },
  { host: 'gitlab.com', key: undefined },
  { host: 'github.com:8443', key: undefined },
  { host: 'ghe.example.com', key: undefined },
])('gives the config key $key for a repository on $host', ({ host, key }) => {
  expect(configRepositoryKey({ host, owner: 'sQVe', name: 'tau' })).toBe(key);
});
