import { execFile } from 'node:child_process';
import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { FakePullRequest, GhFake } from './fixtures/ghFake.js';
import { holdPullRequests, pullRequest } from './fixtures/ghFake.js';
import { createPublicationTool } from './fixtures/publicationRepository.js';
import type { PrInput } from './tool.js';

const setUp = () => createPublicationTool(onTestFinished);

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

  holdPullRequests(fake, 'github.com/sQVe/tau', [pullRequest()]);
  fake.overrideOutput('pr view', '{"url":');

  await expect(run({ ...approved, directory })).rejects.toThrow(
    /^gh pr view 7 .* printed output that is not JSON: \{"url":/u,
  );
});

it('names gh pr view when its JSON lacks a field', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareBody(run);

  holdPullRequests(fake, 'github.com/sQVe/tau', [pullRequest()]);
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
  const outside = temporaryDirectory(onTestFinished, 'tau-pr-outside-');
  const directory = join(root, '.tau', 'pr', 'run-linked');

  await prepareBody(run);
  await writeFile(join(outside, 'body.md'), 'Adds it.\n');
  await symlink(outside, directory);

  await expect(run({ ...approved, directory })).rejects.toThrow('through a symlink');
  expect(fake.calls).toEqual([]);
});

it('refuses to verify a body.md that is a symlink', async () => {
  const { fake, run } = await setUp();
  const { directory } = await run({ action: 'prepare' });
  const outside = temporaryDirectory(onTestFinished, 'tau-pr-outside-');

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
  const outside = temporaryDirectory(onTestFinished, 'tau-pr-outside-');

  await writeFile(join(outside, 'body.md'), 'Adds it.\n');
  await link(join(outside, 'body.md'), join(String(directory), 'body.md'));

  await expect(run({ ...approved, directory: String(directory) })).rejects.toThrow(
    'Refusing to read through a file with another hard link',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses to verify a body.md that is a FIFO', async () => {
  const { fake, run } = await setUp();
  const { directory } = await run({ action: 'prepare' });

  await promisify(execFile)('mkfifo', [join(String(directory), 'body.md')]);

  await expect(run({ ...approved, directory: String(directory) })).rejects.toThrow(
    'is not a regular file',
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
