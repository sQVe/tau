import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createGhFake } from './fixtures/ghFake.js';
import type { FakePullRequest, GhFake } from './fixtures/ghFake.js';
import { createPrTool } from './tool.js';
import type { PrInput } from './tool.js';

const githubUrl = (repository: string) => `https://github.com/${repository}.git`;

const git = async (cwd: string, ...commandArguments: string[]) => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd });

  return stdout.trim();
};

const createBareRemote = async (url: string, checkout: string) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-pr-remote-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  await git(directory, 'init', '--quiet', '--bare', '--initial-branch=main');
  await git(checkout, 'config', `url.${directory}.insteadOf`, url);

  return directory;
};

// A checkout whose origin is github.com/<origin>, with main pushed and the feature branch checked
// out. forkPoint is the SHA where feature leaves main.
const setUp = async (origin = 'sQVe/tau') => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createGhFake();

  await createBareRemote(githubUrl(origin), root);
  await git(root, 'remote', 'add', 'origin', githubUrl(origin));
  await git(root, 'commit', '--quiet', '--allow-empty', '-m', 'base');
  await git(root, 'push', '--quiet', 'origin', 'main');

  const forkPoint = await git(root, 'rev-parse', 'HEAD');

  await git(root, 'checkout', '--quiet', '-b', 'feature');
  await git(root, 'commit', '--quiet', '--allow-empty', '-m', 'feature');

  fake.repositories[`github.com/${origin}`] = { defaultBranch: 'main' };

  const run = async (input: PrInput) => {
    const tool = createPrTool(fake.exec);
    const result = await tool.execute('call', input, undefined, undefined, noUiContext(root));

    return result.details;
  };

  return { root, fake, forkPoint, run };
};

const pushFeature = (root: string) => git(root, 'push', '--quiet', '-u', 'origin', 'feature');

const pullRequest = (overrides: Partial<FakePullRequest> = {}): FakePullRequest => ({
  number: 7,
  state: 'OPEN',
  title: 'Add a feature',
  body: 'Adds it.',
  baseRefName: 'main',
  isDraft: true,
  headRefOid: 'abc123',
  headOwner: 'sQVe',
  headBranch: 'feature',
  ...overrides,
});

const holdPullRequests = (fake: GhFake, repository: string, prs: FakePullRequest[]) => {
  fake.pullRequests[repository] = prs;
};

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

it("targets a fork's upstream repository and fetches the base from its remote", async () => {
  const { root, fake, forkPoint, run } = await setUp('fork/tau');
  const upstreamUrl = 'git@github.com:sQVe/tau.git';
  const upstream = await createBareRemote(upstreamUrl, root);

  await git(root, 'push', '--quiet', upstream, 'main');
  await git(root, 'remote', 'add', 'upstream', upstreamUrl);
  await pushFeature(root);

  fake.repositories['github.com/fork/tau'] = { defaultBranch: 'main', parent: 'sQVe/tau' };
  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };
  holdPullRequests(fake, 'github.com/sQVe/tau', [pullRequest({ headOwner: 'fork' })]);

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    repository: 'github.com/sQVe/tau',
    head: { remote: 'origin', repository: 'github.com/fork/tau', owner: 'fork' },
    base: { remote: 'upstream', branch: 'main' },
    mergeBase: forkPoint,
    pr: { number: 7 },
  });
});

it('takes the head repository from the push URL of a remote that fetches from the upstream', async () => {
  const { root, fake, forkPoint, run } = await setUp();
  const forkUrl = githubUrl('fork/tau');

  await createBareRemote(forkUrl, root);
  await git(root, 'config', 'remote.origin.pushurl', forkUrl);
  await pushFeature(root);

  fake.repositories['github.com/fork/tau'] = { defaultBranch: 'main', parent: 'sQVe/tau' };

  holdPullRequests(fake, 'github.com/sQVe/tau', [
    pullRequest({ number: 4, headOwner: 'sQVe' }),
    pullRequest({ headOwner: 'fork' }),
  ]);

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    repository: 'github.com/sQVe/tau',
    head: { remote: 'origin', repository: 'github.com/fork/tau', owner: 'fork' },
    base: { remote: 'origin', branch: 'main' },
    mergeBase: forkPoint,
    pr: { number: 7 },
  });
});

it('pins the merge base when the fetch refspec leaves out the base branch', async () => {
  const { root, forkPoint, run } = await setUp();

  const featureOnly = '+refs/heads/feature:refs/remotes/origin/feature';

  await pushFeature(root);
  await git(root, 'config', 'remote.origin.fetch', featureOnly);
  await git(root, 'update-ref', '-d', 'refs/remotes/origin/main');

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    base: { remote: 'origin', branch: 'main' },
    mergeBase: forkPoint,
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

it('prepares a fresh run directory that Git ignores', async () => {
  const { root, run } = await setUp();

  const first = await run({ action: 'prepare' });
  const second = await run({ action: 'prepare' });
  const directory = String(first['directory']);

  expect(relative(root, directory)).toMatch(/^\.tau\/pr\/run-\w{6}$/u);
  expect(second['directory']).not.toBe(directory);
  expect((await stat(directory)).isDirectory()).toBe(true);
  await expect(git(root, 'check-ignore', '--quiet', join(directory, 'body.md'))).resolves.toBe('');
});
