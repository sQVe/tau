import { expect, it, onTestFinished } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { holdPullRequests, pullRequest } from './fixtures/ghFake.js';
import {
  createBareRemote,
  createPublicationTool,
  githubUrl,
  pushFeature,
} from './fixtures/publicationRepository.js';

// A checkout whose origin is github.com/<origin>, with main pushed and the feature branch checked
// out. forkPoint is the SHA where feature leaves main.
const setUp = (origin?: string) =>
  createPublicationTool(onTestFinished, {
    ...(origin === undefined ? {} : { origin }),
    remote: true,
  });

it('returns the open pull request, its base, the head SHA, and the merge base', async () => {
  const { root, fake, forkPoint, run } = await setUp();

  await pushFeature(root);
  holdPullRequests(fake, 'github.com/sQVe/tau', [pullRequest()]);

  const details = await run({ action: 'target' });

  expect(details).toEqual({
    host: 'github.com',
    repository: 'github.com/sQVe/tau',
    head: {
      remote: 'origin',
      repository: 'github.com/sQVe/tau',
      owner: 'sQVe',
      branch: 'feature',
      sha: await git(root, 'rev-parse', 'HEAD'),
    },
    base: { remote: 'origin', branch: 'main' },
    mergeBase: forkPoint,
    pr: {
      number: 7,
      url: 'https://github.com/sQVe/tau/pull/7',
      state: 'OPEN',
      title: 'Add a feature',
      body: 'Adds it.',
      baseRefName: 'main',
      isDraft: true,
      headRefOid: 'abc123',
    },
    closedPrs: [],
  });
});

it('bases a branch with no pull request on the default branch', async () => {
  const { root, forkPoint, run } = await setUp();

  await pushFeature(root);

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    base: { remote: 'origin', branch: 'main' },
    mergeBase: forkPoint,
    pr: null,
    closedPrs: [],
  });
});

it('bases a branch with no open pull request on the requested base', async () => {
  const { root, run } = await setUp();

  await git(root, 'push', '--quiet', 'origin', 'main:develop');
  await pushFeature(root);

  const details = await run({ action: 'target', base: 'develop' });

  expect(details).toMatchObject({ base: { remote: 'origin', branch: 'develop' }, pr: null });
});

it('lists merged and closed pull requests apart from the open one', async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);

  holdPullRequests(fake, 'github.com/sQVe/tau', [
    pullRequest({ number: 3, state: 'MERGED', baseRefName: 'release' }),
    pullRequest({ number: 5, state: 'CLOSED' }),
  ]);

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    base: { branch: 'main' },
    pr: null,
    closedPrs: [
      { number: 3, state: 'MERGED' },
      { number: 5, state: 'CLOSED' },
    ],
  });
});

it("leaves out another owner's pull request from a branch of the same name", async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);
  holdPullRequests(fake, 'github.com/sQVe/tau', [pullRequest({ headOwner: 'someone' })]);

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({ pr: null, closedPrs: [] });
});

it('refuses a pull request list that reaches the limit, since it may be incomplete', async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);

  const closed = Array.from({ length: 100 }, (_, index) =>
    pullRequest({ number: index + 100, state: 'CLOSED', headOwner: 'someone' }),
  );

  holdPullRequests(fake, 'github.com/sQVe/tau', [...closed, pullRequest()]);

  await expect(run({ action: 'target' })).rejects.toThrow(
    /^gh pr list --repo github.com\/sQVe\/tau .* printed 100 pull requests, the limit, so the list may be incomplete\./u,
  );
});

it("leaves out a pull request from another repository of the head's owner", async () => {
  const { root, fake, run } = await setUp('team/myfork');
  const upstreamUrl = githubUrl('team/project');
  const upstream = await createBareRemote(onTestFinished, upstreamUrl, root);

  await git(root, 'push', '--quiet', upstream, 'main');
  await git(root, 'remote', 'add', 'upstream', upstreamUrl);
  await pushFeature(root);

  fake.repositories['github.com/team/myfork'] = { defaultBranch: 'main', parent: 'team/project' };
  fake.repositories['github.com/team/project'] = { defaultBranch: 'main' };

  holdPullRequests(fake, 'github.com/team/project', [
    pullRequest({ headOwner: 'team', headRepository: 'project' }),
    pullRequest({ number: 8, state: 'CLOSED', headOwner: 'team', headRepository: 'myfork' }),
  ]);

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    repository: 'github.com/team/project',
    head: { repository: 'github.com/team/myfork', owner: 'team', branch: 'feature' },
    pr: null,
    closedPrs: [{ number: 8 }],
  });
});

it('stops before other gh calls when gh auth status fails', async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);
  fake.failCommand('auth status');

  await expect(run({ action: 'target' })).rejects.toThrow(
    'gh auth status --active --hostname github.com failed',
  );

  expect(fake.calls.map((call) => call.commandArguments.slice(0, 2).join(' '))).toEqual([
    'auth status',
  ]);
});

it('names gh pr list when it prints output the tool cannot read', async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);
  fake.overrideOutput('pr list', JSON.stringify([{ number: 'seven' }]));

  await expect(run({ action: 'target' })).rejects.toThrow(
    /^gh pr list --repo github.com\/sQVe\/tau .* printed unexpected output: \/0 /u,
  );
});

const listedPullRequest = (change: Record<string, unknown> = {}) => ({
  number: 7,
  url: 'https://github.com/sQVe/tau/pull/7',
  state: 'OPEN',
  title: 'Add a feature',
  body: 'Adds it.',
  baseRefName: 'main',
  isDraft: false,
  headRefOid: 'abc123',
  headRepositoryOwner: { login: 'sQVe' },
  headRepository: { name: 'tau' },
  ...change,
});

it.each([
  { condition: 'the owner has no login', change: { headRepositoryOwner: {} } },
  { condition: 'the owner is null', change: { headRepositoryOwner: null } },
  { condition: 'the head repository has no name', change: { headRepository: {} } },
  { condition: 'the head repository is text', change: { headRepository: 'tau' } },
])('names gh pr list when $condition', async ({ change }) => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);
  fake.overrideOutput('pr list', JSON.stringify([listedPullRequest(change)]));

  await expect(run({ action: 'target' })).rejects.toThrow(
    /^gh pr list .* printed unexpected output/u,
  );
});

it('leaves out a pull request whose head repository was deleted', async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);
  fake.overrideOutput('pr list', JSON.stringify([listedPullRequest({ headRepository: null })]));

  await expect(run({ action: 'target' })).resolves.toMatchObject({ pr: null, closedPrs: [] });
});

it('refuses a detached HEAD', async () => {
  const { root, fake, run } = await setUp();

  await git(root, 'checkout', '--quiet', '--detach');

  await expect(run({ action: 'target' })).rejects.toThrow('HEAD is detached');
  expect(fake.calls).toEqual([]);
});

it('refuses the default branch', async () => {
  const { root, run } = await setUp();

  await git(root, 'checkout', '--quiet', 'main');

  await expect(run({ action: 'target' })).rejects.toThrow(
    'main is the default branch of github.com/sQVe/tau',
  );
});

it('refuses a branch that pushes to the default branch', async () => {
  const { root, run } = await setUp();

  await git(root, 'checkout', '--quiet', '-b', 'work');
  await git(root, 'branch', '--quiet', '--set-upstream-to', 'origin/main');
  await git(root, 'config', 'push.default', 'upstream');

  await expect(run({ action: 'target' })).rejects.toThrow(
    'work pushes to main, the default branch of github.com/sQVe/tau',
  );
});

it("checks branches against the fork's default branch, not the upstream's", async () => {
  const { root, fake, run } = await setUp('fork/tau');
  const upstreamUrl = githubUrl('sQVe/tau');
  const upstream = await createBareRemote(onTestFinished, upstreamUrl, root);

  await git(root, 'push', '--quiet', upstream, 'main');
  await git(root, 'remote', 'add', 'upstream', upstreamUrl);
  await git(root, 'checkout', '--quiet', 'main');
  await git(root, 'push', '--quiet', '-u', 'origin', 'main');

  fake.repositories['github.com/fork/tau'] = { defaultBranch: 'trunk', parent: 'sQVe/tau' };
  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    head: { repository: 'github.com/fork/tau', branch: 'main' },
    base: { remote: 'upstream', branch: 'main' },
  });

  await git(root, 'checkout', '--quiet', '-b', 'trunk');
  await git(root, 'push', '--quiet', '-u', 'origin', 'trunk');

  await expect(run({ action: 'target' })).rejects.toThrow(
    'trunk is the default branch of github.com/fork/tau',
  );
});
