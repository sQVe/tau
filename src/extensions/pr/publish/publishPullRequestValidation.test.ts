import { access, chmod, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createPublicationTool } from '../fixtures/publicationRepository.js';
import {
  dryRunPullRequest,
  dryRunPullRequestEdit,
  preparePullRequestRun,
  preparePublicationRun as prepareRun,
  publicationRepository as repository,
  publishedFilePath,
  setUpPublication,
  writeRunFile,
} from '../fixtures/publicationRun.js';

const isRoot = process.getuid?.() === 0;

const setUp = () => setUpPublication(onTestFinished);

it('refuses a dry run or publish that lacks a required input', async () => {
  const { fake, run } = await setUp();
  const directory = await preparePullRequestRun(run);

  await expect(run({ action: 'dryRun', repository, directory })).rejects.toThrow(
    'dryRun needs kind',
  );

  await expect(
    run({ action: 'dryRun', kind: 'pullRequest', repository, directory }),
  ).rejects.toThrow('dryRun needs base.');

  await expect(
    run({ action: 'dryRun', kind: 'pullRequest', repository, directory, base: 'main' }),
  ).rejects.toThrow('dryRun needs head.');

  await expect(run({ ...dryRunPullRequest(directory), action: 'publish' })).rejects.toThrow(
    'publish needs token from dryRun.',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses a title.md that holds a line break', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'body.md', 'Adds it.\n');
  await writeRunFile(directory, 'title.md', 'Add a feature\nover two lines\n');

  await expect(run(dryRunPullRequest(directory))).rejects.toThrow(
    'title.md must contain one line.',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses a whitespace-only title.md at the dry run', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'body.md', 'Adds it.\n');
  await writeRunFile(directory, 'title.md', '   \n');

  await expect(run(dryRunPullRequest(directory))).rejects.toThrow('title.md must not be empty.');

  expect(fake.calls).toEqual([]);
});

it('trims base and head and refuses a whitespace-only value', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'body.md', 'Adds it.\n');

  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  await expect(run({ ...dryRunPullRequest(directory), base: '  ' })).rejects.toThrow(
    'dryRun needs base.',
  );

  await expect(run({ ...dryRunPullRequest(directory), head: '\t' })).rejects.toThrow(
    'dryRun needs head.',
  );

  expect(fake.calls).toEqual([]);

  const request = { ...dryRunPullRequest(directory), base: ' main ', head: ' feature ' };
  const dryRun = await run(request);

  await run({ ...request, action: 'publish', token: dryRun.token });

  expect(fake.writes[0]?.commandArguments).toEqual([
    'pr',
    'create',
    '--repo',
    'github.com/sQVe/tau',
    '--base',
    'main',
    '--head',
    'feature',
    '--title',
    'Add a feature',
    '--body-file',
    expect.stringMatching(/tau-publish-[^/]+\/\d+-body\.md$/u),
    '--draft',
  ]);
});

it('refuses to publish when only title.md changed and names it', async () => {
  const { fake, run } = await setUp();
  const directory = await preparePullRequestRun(run);

  const request = dryRunPullRequest(directory);
  const dryRun = await run(request);

  await writeRunFile(directory, 'title.md', 'Another title\n');

  await expect(run({ ...request, action: 'publish', token: dryRun.token })).rejects.toThrow(
    /title\.md changed since the dry run/u,
  );

  expect(fake.calls).toEqual([]);
});

it('refuses to publish a token from another create target and sends nothing', async () => {
  const { fake, run } = await setUp();
  const directory = await preparePullRequestRun(run);

  const request = dryRunPullRequest(directory);
  const dryRun = await run(request);
  const changes = [{ base: 'develop' }, { head: 'other' }, { draft: false }];

  for (const change of changes) {
    await expect(
      run({ ...request, ...change, action: 'publish', token: dryRun.token }),
    ).rejects.toThrow('The token covers a different publication target');
  }

  expect(fake.calls).toEqual([]);
});

it('refuses to publish a token from another pull request and sends nothing', async () => {
  const { fake, run } = await setUp();
  const directory = await preparePullRequestRun(run);

  const request = dryRunPullRequestEdit(directory);
  const dryRun = await run(request);

  await expect(run({ ...request, action: 'publish', pr: 8, token: dryRun.token })).rejects.toThrow(
    'The token covers a different publication target',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses to publish a token from another run directory and sends nothing', async () => {
  const { fake, run } = await setUp();
  const first = await prepareRun(run);
  const second = await prepareRun(run);

  for (const directory of [first, second]) {
    await writeRunFile(directory, 'body.md', 'Adds it.\n');
    await writeRunFile(directory, 'title.md', 'Add a feature\n');
  }

  const dryRun = await run(dryRunPullRequest(first));

  await expect(
    run({
      ...dryRunPullRequest(second),
      action: 'publish',
      token: dryRun.token,
    }),
  ).rejects.toThrow('The token covers a different publication target');

  expect(fake.calls).toEqual([]);
});

it('refuses a run directory without body.md', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  await expect(run(dryRunPullRequest(directory))).rejects.toThrow('No body.md at');

  expect(fake.calls).toEqual([]);
});

it('refuses to publish when a file changed after the dry run and sends nothing', async () => {
  const { fake, run } = await setUp();
  const directory = await preparePullRequestRun(run);

  const request = dryRunPullRequest(directory);
  const dryRun = await run(request);

  await writeRunFile(directory, 'body.md', 'Adds something else.\n');

  await expect(run({ ...request, action: 'publish', token: dryRun.token })).rejects.toThrow(
    /body\.md changed since the dry run/u,
  );

  expect(fake.calls).toEqual([]);
});

it('publishes the verified bytes when the file changes after the token check', async () => {
  let directory = '';
  let publishedPath = '';
  let fileMode = 0;
  let directoryMode = 0;

  const { fake, run } = await createPublicationTool(onTestFinished, {
    wrapExec: (exec) => async (command, commandArguments, options) => {
      publishedPath = commandArguments[commandArguments.indexOf('--body-file') + 1] ?? '';
      fileMode = (await stat(publishedPath)).mode;
      directoryMode = (await stat(dirname(publishedPath))).mode;
      await writeFile(join(directory, 'body.md'), 'Changed after the token check.\n');

      return exec(command, commandArguments, options);
    },
  });

  directory = await prepareRun(run);

  await writeRunFile(directory, 'body.md', 'Adds it.\n');
  await writeRunFile(directory, 'title.md', 'Add a feature\n');

  const request = dryRunPullRequestEdit(directory);
  const dryRun = await run(request);

  await run({ ...request, action: 'publish', token: dryRun.token });

  expect(fake.writes[0]?.contents).toEqual(Buffer.from('Adds it.\n'));
  expect(fileMode & 0o777).toBe(0o600);
  expect(directoryMode & 0o777).toBe(0o700);
  await expect(access(publishedPath)).rejects.toThrow(/ENOENT/u);
});

it('removes the verified copy when the publish fails and names the run file', async () => {
  const { fake, run } = await setUp();
  const directory = await preparePullRequestRun(run);

  const request = dryRunPullRequestEdit(directory);
  const dryRun = await run(request);

  fake.failCommand('pr edit', 'boom');

  const failure: unknown = await run({
    ...request,
    action: 'publish',
    token: dryRun.token,
  }).catch((error: unknown) => error);

  expect(String(failure)).toContain(`--body-file ${join(directory, 'body.md')}`);
  expect(String(failure)).not.toContain('tau-publish-');

  const publishedPath = publishedFilePath(fake);

  expect(publishedPath).toMatch(/tau-publish-/u);
  await expect(access(publishedPath)).rejects.toThrow(/ENOENT/u);
});

it.skipIf(isRoot)('keeps the publish result when the private copy cannot be removed', async () => {
  let privateDirectory = '';

  const { run } = await createPublicationTool(onTestFinished, {
    wrapExec: (exec) => async (command, commandArguments, options) => {
      privateDirectory = dirname(
        commandArguments[commandArguments.indexOf('--body-file') + 1] ?? '',
      );

      await chmod(privateDirectory, 0o500);

      return exec(command, commandArguments, options);
    },
  });

  const directory = await preparePullRequestRun(run);

  const request = dryRunPullRequest(directory);
  const dryRun = await run(request);

  onTestFinished(async () => {
    if (privateDirectory === '') {
      return;
    }

    await chmod(privateDirectory, 0o700);
    await rm(privateDirectory, { recursive: true, force: true });
  });

  const published = await run({ ...request, action: 'publish', token: dryRun.token });

  expect(published.url).toBe('https://github.com/sQVe/tau/pull/8');
});

const createInputValues = { base: 'main', head: 'feature', draft: true } as const;

it.each(['base', 'head', 'draft'] as const)('refuses %s together with pr', async (name) => {
  const { fake, run } = await setUp();
  const directory = await preparePullRequestRun(run);

  const request = { action: 'dryRun', kind: 'pullRequest', repository, directory, pr: 7 } as const;
  const createInput = { [name]: createInputValues[name] };

  await expect(run({ ...request, ...createInput })).rejects.toThrow(
    `dryRun cannot take ${name} with pr.`,
  );

  expect(fake.calls).toEqual([]);
});

it('refuses a create input on publish too', async () => {
  const { fake, run } = await setUp();
  const directory = await preparePullRequestRun(run);

  const request = { action: 'dryRun', kind: 'pullRequest', repository, directory, pr: 7 } as const;
  const dryRun = await run(request);

  await expect(
    run({ ...request, action: 'publish', token: dryRun.token, base: 'main' }),
  ).rejects.toThrow('publish cannot take base with pr.');

  expect(fake.calls).toEqual([]);
});

it('refuses file for a pull request in the dry run', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await expect(run({ ...dryRunPullRequest(directory), file: 'comment.md' })).rejects.toThrow(
    'dryRun with kind pullRequest cannot take file.',
  );

  expect(fake.calls).toEqual([]);
});

it('refuses file for a pull request in publish', async () => {
  const { fake, run } = await setUp();
  const directory = await preparePullRequestRun(run);

  const request = dryRunPullRequest(directory);
  const dryRun = await run(request);

  await expect(
    run({ ...request, action: 'publish', token: dryRun.token, file: 'comment.md' }),
  ).rejects.toThrow('publish with kind pullRequest cannot take file.');

  expect(fake.calls).toEqual([]);
});
