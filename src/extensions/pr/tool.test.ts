import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createGhFake } from './fixtures/ghFake.js';
import type { FakePullRequest, GhFake } from './fixtures/ghFake.js';
import { readGitBytes } from './git.js';
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

  await git(root, 'config', 'maintenance.auto', 'false');
  await git(root, 'config', 'gc.auto', '0');
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

it('returns publication evidence through the tool', async () => {
  const { root, forkPoint, run } = await setUp();

  await pushFeature(root);

  const evidence = await run({ action: 'evidence' });

  expect(evidence).toMatchObject({
    target: { mergeBase: forkPoint, head: { branch: 'feature' }, pr: null, closedPrs: [] },
    branch: 'feature',
    subjects: ['feature'],
    reuse: null,
    review: null,
    checks: [],
    gaps: [{ kind: 'noReview' }, { kind: 'noChecks' }],
  });
});

it('makes a check log match evidence for a committed diff over 1 MiB', async () => {
  const { root, forkPoint, fake, run } = await setUp();
  const content = 'a line of committed content\n'.repeat(80_000);

  await writeFile(join(root, 'large.txt'), content);
  await git(root, 'add', 'large.txt');
  await git(root, 'commit', '--quiet', '-m', 'large change');
  await pushFeature(root);

  const diff = await readGitBytes(root, ['diff', forkPoint, 'HEAD']);

  expect(diff.length).toBeGreaterThan(1_048_576);

  const { directory } = await run({ action: 'prepare' });
  const checks = join(String(directory), 'checks');

  await mkdir(checks);
  await writeFile(join(root, 'large.txt'), `${content}dirty\n`);

  const files = await readdir(root, { recursive: true });
  const status = await git(root, 'status', '--porcelain');
  const head = await git(root, 'rev-parse', 'HEAD');
  const header = await run({ action: 'checkHeader', mergeBase: forkPoint });

  expect(header['lines']).toHaveLength(3);
  expect(await readdir(root, { recursive: true })).toEqual(files);
  expect(await git(root, 'status', '--porcelain')).toBe(status);
  expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
  expect(fake.calls).toEqual([]);

  const path = join(checks, 'test.log');
  const lines = header['lines'] as string[];

  await writeFile(path, `${lines.join('\n')}\ntests passed\n`);

  const evidence = await run({ action: 'evidence' });

  expect(evidence['checks']).toEqual([
    { path, matches: true, reasons: [], excerpt: 'tests passed', truncated: false },
  ]);
});

it.each([
  { name: 'a missing mergeBase', mergeBase: undefined, error: 'checkHeader needs mergeBase.' },
  { name: 'an unknown revision', mergeBase: 'missing-commit', error: /^git rev-parse .* failed:/u },
  {
    name: 'a tree instead of a commit',
    mergeBase: 'HEAD^{tree}',
    error: /^git rev-parse .* failed:/u,
  },
])(
  'refuses check headers for $name without changing the checkout',
  async ({ mergeBase, error }) => {
    const { root, fake, run } = await setUp();
    const files = await readdir(root, { recursive: true });
    const head = await git(root, 'rev-parse', 'HEAD');
    const status = await git(root, 'status', '--porcelain');

    const input: PrInput = {
      action: 'checkHeader',
      ...(mergeBase === undefined ? {} : { mergeBase }),
    };

    await expect(run(input)).rejects.toThrow(error);

    expect(await readdir(root, { recursive: true })).toEqual(files);
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(root, 'status', '--porcelain')).toBe(status);
    expect(fake.calls).toEqual([]);
  },
);

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

it('fetches the base from the remote that fetches the base repository, not one that pushes to it', async () => {
  const { root, fake, forkPoint, run } = await setUp('fork/tau');
  const upstreamUrl = githubUrl('sQVe/tau');
  const forkRemote = await git(root, 'remote', 'get-url', 'origin');

  await createBareRemote(upstreamUrl, root);
  await git(root, 'push', '--quiet', forkRemote, 'feature:main');
  await git(root, 'config', 'remote.origin.pushurl', upstreamUrl);
  await git(root, 'push', '--quiet', upstreamUrl, 'main');
  await git(root, 'remote', 'add', 'upstream', upstreamUrl);
  await pushFeature(root);

  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    head: { remote: 'origin', repository: 'github.com/sQVe/tau' },
    base: { remote: 'upstream', branch: 'main' },
    mergeBase: forkPoint,
  });
});

it('takes the head repository from a pushInsteadOf rewrite', async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);
  await git(root, 'config', `url.${githubUrl('fork/tau')}.pushInsteadOf`, githubUrl('sQVe/tau'));

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
    pr: { number: 7 },
  });
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

it('refuses a branch whose configured remote does not exist', async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);
  await git(root, 'config', 'branch.feature.remote', 'gone');

  await expect(run({ action: 'target' })).rejects.toThrow(
    "git rev-parse --abbrev-ref @{push} failed: fatal: upstream branch 'refs/heads/feature' not stored as a remote-tracking branch",
  );

  expect(fake.calls).toEqual([]);
});

// Points origin at an SSH URL that Git still rewrites to the local bare repository.
const aliasOrigin = async (root: string, url: string) => {
  const bare = await git(root, 'remote', 'get-url', 'origin');

  await git(root, 'config', '--add', `url.${bare}.insteadOf`, url);
  await git(root, 'remote', 'set-url', 'origin', url);
};

// SSH config can match on the user and port, such as with `Match user git`, so the alias alone
// resolves to another host here.
it.each([
  { url: 'git@github-work:sQVe/tau.git', alias: 'github-work', destination: 'git@github-work' },
  {
    url: 'ssh://git@github-alt:2222/sQVe/tau.git',
    alias: 'github-alt',
    destination: '-p 2222 git@github-alt',
  },
])('resolves the SSH destination in $url', async ({ url, alias, destination }) => {
  const { root, fake, run } = await setUp();

  await aliasOrigin(root, url);
  await pushFeature(root);
  fake.sshHostnames[alias] = 'wrong.example.com';
  fake.sshHostnames[destination] = 'github.com';

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    host: 'github.com',
    repository: 'github.com/sQVe/tau',
    head: { remote: 'origin', repository: 'github.com/sQVe/tau' },
    base: { remote: 'origin', branch: 'main' },
  });

  expect(fake.calls[0]?.commandArguments).toEqual([
    'auth',
    'status',
    '--active',
    '--hostname',
    'github.com',
  ]);
});

it('reads the server branch through a custom fetch mapping', async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);
  await git(root, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/cache/*');
  await git(root, 'fetch', '--quiet', 'origin');
  holdPullRequests(fake, 'github.com/sQVe/tau', [pullRequest()]);

  const details = await run({ action: 'target' });

  expect(details).toMatchObject({
    head: { remote: 'origin', branch: 'feature' },
    base: { remote: 'origin', branch: 'main' },
    pr: { number: 7 },
  });
});

it('refuses a head remote whose push URLs name different repositories', async () => {
  const { root, fake, run } = await setUp();

  await pushFeature(root);
  await git(root, 'config', '--add', 'remote.origin.pushurl', githubUrl('sQVe/tau'));
  await git(root, 'config', '--add', 'remote.origin.pushurl', githubUrl('other/tau'));

  await expect(run({ action: 'target' })).rejects.toThrow(
    'Remote origin pushes to several repositories: github.com/sQVe/tau, github.com/other/tau.',
  );

  expect(fake.calls).toEqual([]);
});

it("leaves out a pull request from another repository of the head's owner", async () => {
  const { root, fake, run } = await setUp('team/myfork');
  const upstreamUrl = githubUrl('team/project');
  const upstream = await createBareRemote(upstreamUrl, root);

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
  const upstream = await createBareRemote(upstreamUrl, root);

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

const approved = {
  action: 'verify',
  repository: 'github.com/sQVe/tau',
  pr: 7,
  title: 'Add a feature',
  base: 'main',
  draft: true,
} as const;

const prepareBody = async (run: (input: PrInput) => Promise<Record<string, unknown>>) => {
  const { directory } = await run({ action: 'prepare' });
  const runDirectory = String(directory);

  await writeFile(join(runDirectory, 'body.md'), 'Adds it.\n');

  return runDirectory;
};

const holdPublished = async (
  fake: GhFake,
  root: string,
  overrides: Partial<FakePullRequest> = {},
) => {
  const headRefOid = await git(root, 'rev-parse', 'HEAD');

  holdPullRequests(fake, 'github.com/sQVe/tau', [pullRequest({ headRefOid, ...overrides })]);
};

const ghCommands = (fake: GhFake) =>
  fake.calls.map((call) => call.commandArguments.slice(0, 2).join(' '));

it('verifies a published pull request that matches the approved preview', async () => {
  const { root, fake, run } = await setUp();
  const directory = await prepareBody(run);

  await holdPublished(fake, root);

  const details = await run({ ...approved, directory });

  expect(details).toEqual({
    url: 'https://github.com/sQVe/tau/pull/7',
    matches: true,
    differences: [],
  });

  expect(ghCommands(fake)).toEqual(['pr view']);
});

it('reports each field of the published pull request that differs', async () => {
  const { root, fake, run } = await setUp();
  const directory = await prepareBody(run);

  await holdPublished(fake, root, { body: 'Adds something else.' });

  const details = await run({ ...approved, directory });

  expect(details).toEqual({
    url: 'https://github.com/sQVe/tau/pull/7',
    matches: false,
    differences: [{ field: 'body', expected: 'Adds it.\n', actual: 'Adds something else.' }],
  });
});

it('fails verify when gh pr view cannot find the pull request', async () => {
  const { run } = await setUp();
  const directory = await prepareBody(run);

  await expect(run({ ...approved, directory })).rejects.toThrow(
    'gh pr view 7 --repo github.com/sQVe/tau --json url,title,body,baseRefName,isDraft,headRefOid failed',
  );
});

it('names gh pr view when it prints output that is not JSON', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareBody(run);

  fake.overrideOutput('pr view', '{"url":');

  await expect(run({ ...approved, directory })).rejects.toThrow(
    /^gh pr view 7 .* printed output that is not JSON: \{"url":/u,
  );
});

it('names gh pr view when its JSON lacks a field', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareBody(run);

  fake.overrideOutput('pr view', JSON.stringify({ url: 'https://github.com/sQVe/tau/pull/7' }));

  await expect(run({ ...approved, directory })).rejects.toThrow(
    /^gh pr view 7 .* printed unexpected output: /u,
  );
});

it('refuses to verify without a body.md in the run directory', async () => {
  const { fake, run } = await setUp();
  const { directory } = await run({ action: 'prepare' });

  await expect(run({ ...approved, directory: String(directory) })).rejects.toThrow('No body.md at');
  expect(fake.calls).toEqual([]);
});

it('refuses to verify a directory that prepare did not create', async () => {
  const { root, fake, run } = await setUp();
  const directory = join(root, '.tau', 'pr', 'other');

  await prepareBody(run);
  await mkdir(directory);
  await writeFile(join(directory, 'body.md'), 'Adds it.\n');

  await expect(run({ ...approved, directory })).rejects.toThrow(
    'The body directory must be named run-* by prepare, not',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses to verify a run directory that is a symlink', async () => {
  const { root, fake, run } = await setUp();
  const outside = await mkdtemp(join(tmpdir(), 'tau-pr-outside-'));
  const directory = join(root, '.tau', 'pr', 'run-linked');

  onTestFinished(() => rm(outside, { recursive: true, force: true }));
  await prepareBody(run);
  await writeFile(join(outside, 'body.md'), 'Adds it.\n');
  await symlink(outside, directory);

  await expect(run({ ...approved, directory })).rejects.toThrow('through a symlink');
  expect(fake.calls).toEqual([]);
});

it('refuses to verify a body.md that is a symlink', async () => {
  const { fake, run } = await setUp();
  const { directory } = await run({ action: 'prepare' });
  const outside = await mkdtemp(join(tmpdir(), 'tau-pr-outside-'));

  onTestFinished(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'body.md'), 'Adds it.\n');
  await symlink(join(outside, 'body.md'), join(String(directory), 'body.md'));

  await expect(run({ ...approved, directory: String(directory) })).rejects.toThrow(
    'through a symlink',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses to verify a body.md with another hard link', async () => {
  const { fake, run } = await setUp();
  const { directory } = await run({ action: 'prepare' });
  const outside = await mkdtemp(join(tmpdir(), 'tau-pr-outside-'));

  onTestFinished(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'body.md'), 'Adds it.\n');
  await link(join(outside, 'body.md'), join(String(directory), 'body.md'));

  await expect(run({ ...approved, directory: String(directory) })).rejects.toThrow(
    'Refusing to read a body.md with another hard link',
  );

  expect(fake.calls).toEqual([]);
});

it('reports a head difference when local HEAD moved after the push', async () => {
  const { root, fake, run } = await setUp();
  const directory = await prepareBody(run);
  const pushed = await git(root, 'rev-parse', 'HEAD');

  await holdPublished(fake, root);
  await git(root, 'commit', '--quiet', '--allow-empty', '-m', 'later');

  const details = await run({ ...approved, directory });

  expect(details).toEqual({
    url: 'https://github.com/sQVe/tau/pull/7',
    matches: false,
    differences: [
      { field: 'head', expected: await git(root, 'rev-parse', 'HEAD'), actual: pushed },
    ],
  });
});

it('refuses to verify a directory outside .tau/pr', async () => {
  const { root, fake, run } = await setUp();

  await expect(run({ ...approved, directory: join(root, '.tau', 'run-other') })).rejects.toThrow(
    'The body directory must be in .tau/pr, not',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses to verify a directory nested in a run directory', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareBody(run);

  await expect(run({ ...approved, directory: join(directory, 'inner') })).rejects.toThrow(
    'The body directory must sit directly in .tau/pr, not',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses to verify a pull request number that is not an integer', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareBody(run);

  await expect(run({ ...approved, pr: 1.5, directory })).rejects.toThrow(
    'pr must be an integer, not 1.5.',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses to verify a pull request number below 1', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareBody(run);

  await expect(run({ ...approved, pr: 0, directory })).rejects.toThrow(
    'pr must be 1 or more, not 0.',
  );

  expect(fake.calls).toEqual([]);
});
