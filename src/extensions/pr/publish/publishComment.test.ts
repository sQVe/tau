import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import {
  foreignInputOf,
  preparePublicationRun as prepareRun,
  publicationRepository as repository,
  publishedCommands,
  setUpPublication,
  writeRunFile,
} from '../fixtures/publicationRun.js';

const setUp = () => setUpPublication(onTestFinished);

it('publishes a comment file under bots', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  await writeRunFile(directory, 'bots/0.md', 'Looks good.\n');

  const request = {
    action: 'dryRun',
    kind: 'comment',
    repository,
    directory,
    pr: 1,
    file: 'bots/0.md',
  } as const;

  const dryRun = await run(request);

  const published = await run({ ...request, action: 'publish', token: dryRun.token });

  expect(fake.writes).toEqual([
    {
      key: 'pr comment',
      commandArguments: [
        'pr',
        'comment',
        '1',
        '--repo',
        'github.com/sQVe/tau',
        '--body-file',
        expect.stringMatching(/tau-publish-[^/]+\/\d+-0\.md$/u),
      ],
      contents: Buffer.from('Looks good.\n'),
    },
  ]);

  expect(published.url).toBe('https://github.com/sQVe/tau/pull/1#issuecomment-1');
  expect(publishedCommands(fake)).toEqual(['pr comment']);
});

it('refuses a comment file that is an absolute path', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const file = await writeRunFile(directory, 'comment.md', 'Looks good.\n');

  await expect(
    run({ action: 'dryRun', kind: 'comment', repository, directory, pr: 7, file }),
  ).rejects.toThrow('The comment file must be relative to the run directory');

  expect(fake.calls).toEqual([]);
});

it('refuses a comment file that climbs out of the run directory', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await expect(
    run({
      action: 'dryRun',
      kind: 'comment',
      repository,
      directory,
      pr: 7,
      file: '../body.md',
    }),
  ).rejects.toThrow('The comment file must stay in the run directory');

  expect(fake.calls).toEqual([]);
});

it('refuses a comment file path with a backslash', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await expect(
    run({
      action: 'dryRun',
      kind: 'comment',
      repository,
      directory,
      pr: 7,
      file: 'bots\\0.md',
    }),
  ).rejects.toThrow('The comment file must not contain a backslash');

  expect(fake.calls).toEqual([]);
});

it('refuses a comment file that is a directory', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const path = join(directory, 'bots');

  await mkdir(path);

  await expect(
    run({ action: 'dryRun', kind: 'comment', repository, directory, pr: 7, file: 'bots' }),
  ).rejects.toThrow(`not a regular file: ${path}`);

  expect(fake.calls).toEqual([]);
});

it('refuses a comment file that is a symlink', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const outside = temporaryDirectory(onTestFinished, 'tau-pr-outside-');

  await writeFile(join(outside, 'comment.md'), 'Looks good.\n');
  await symlink(join(outside, 'comment.md'), join(directory, 'comment.md'));

  await expect(
    run({
      action: 'dryRun',
      kind: 'comment',
      repository,
      directory,
      pr: 7,
      file: 'comment.md',
    }),
  ).rejects.toThrow('through a symlink');

  expect(fake.calls).toEqual([]);
});

it('refuses a comment file with another hard link', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);
  const outside = temporaryDirectory(onTestFinished, 'tau-pr-outside-');

  await writeFile(join(outside, 'comment.md'), 'Looks good.\n');
  await link(join(outside, 'comment.md'), join(directory, 'comment.md'));

  await expect(
    run({
      action: 'dryRun',
      kind: 'comment',
      repository,
      directory,
      pr: 7,
      file: 'comment.md',
    }),
  ).rejects.toThrow('another hard link');

  expect(fake.calls).toEqual([]);
});

it('refuses a comment path whose parent is a file', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'body.md', 'Adds it.\n');

  await expect(
    run({
      action: 'dryRun',
      kind: 'comment',
      repository,
      directory,
      pr: 7,
      file: 'body.md/inside.md',
    }),
  ).rejects.toThrow('No body.md/inside.md at');

  expect(fake.calls).toEqual([]);
});

it('refuses a whitespace-only comment file', async () => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'bots/0.md', '  \n');

  await expect(
    run({
      action: 'dryRun',
      kind: 'comment',
      repository,
      directory,
      pr: 7,
      file: 'bots/0.md',
    }),
  ).rejects.toThrow('bots/0.md must not be empty.');

  expect(fake.calls).toEqual([]);
});

const commentRequest = (directory: string) =>
  ({
    action: 'dryRun',
    kind: 'comment',
    repository,
    directory,
    pr: 7,
    file: 'comment.md',
  }) as const;

it.each(['base', 'head', 'draft'] as const)(
  'refuses %s for a comment in the dry run',
  async (name) => {
    const { fake, run } = await setUp();
    const directory = await prepareRun(run);
    const foreignInput = foreignInputOf(name);

    await expect(run({ ...commentRequest(directory), ...foreignInput })).rejects.toThrow(
      `dryRun with kind comment cannot take ${name}.`,
    );

    expect(fake.calls).toEqual([]);
  },
);

it.each(['base', 'head', 'draft'] as const)('refuses %s for a comment in publish', async (name) => {
  const { fake, run } = await setUp();
  const directory = await prepareRun(run);

  await writeRunFile(directory, 'comment.md', 'Looks good.\n');

  const dryRun = await run(commentRequest(directory));
  const foreignInput = foreignInputOf(name);

  await expect(
    run({ ...commentRequest(directory), action: 'publish', token: dryRun.token, ...foreignInput }),
  ).rejects.toThrow(`publish with kind comment cannot take ${name}.`);

  expect(fake.calls).toEqual([]);
});
