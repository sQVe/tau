import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { comment, fixture, stagingOf } from './fixtures/reviewFixture.js';

const runPaths = ['run-b/title.md', 'run-b/body.md', 'run-a/title.md', 'run-a/body.md'];

const openStack = async () => {
  const context = await fixture();

  await Promise.all(
    runPaths.map(async (path) => {
      await mkdir(dirname(context.real(`pr/${path}`)), { recursive: true });
      await writeFile(context.real(`pr/${path}`), `${path}\n`);
    }),
  );

  const opened = await context.run({
    action: 'open',
    paths: runPaths.map((path) => `.tau/pr/${path}`),
  });

  if (opened.details.status !== 'manual') {
    throw new Error('Expected a manual review.');
  }

  const { directory, command } = opened.details;

  return { ...context, directory, staging: stagingOf(command) };
};

it('stages the files so that sorting by name keeps the order of the paths', async () => {
  const { staging } = await openStack();
  const staged = await readdir(staging, { recursive: true, withFileTypes: true });

  const files = staged
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(staging.length + 1))
    .toSorted();

  expect(files).toEqual([
    '01-pr-run-b/1-title.md',
    '01-pr-run-b/2-body.md',
    '02-pr-run-a/1-title.md',
    '02-pr-run-a/2-body.md',
  ]);

  expect(await readFile(join(staging, '02-pr-run-a/2-body.md'), 'utf8')).toBe('run-a/body.md\n');
});

it('returns comments and edits on staged names under their .tau paths', async () => {
  const { run, setSession, real, directory, staging } = await openStack();

  await writeFile(join(staging, '02-pr-run-a/2-body.md'), 'edited\n');
  await setSession([comment('on-title', '01-pr-run-b/1-title.md')]);

  const collected = await run({ action: 'collect', directory });

  expect(collected.details).toMatchObject({
    comments: [{ path: real('pr/run-b/title.md'), content: 'on-title' }],
    edits: [{ path: real('pr/run-a/body.md'), status: 'applied' }],
  });

  expect(await readFile(real('pr/run-a/body.md'), 'utf8')).toBe('edited\n');
  expect(await readFile(real('pr/run-b/body.md'), 'utf8')).toBe('run-b/body.md\n');
});

it('collects a version 2 record whose files are staged under their .tau paths', async () => {
  const { run, setSession, real, directory } = await openStack();
  const manifestPath = join(directory, 'review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const { stagingDirectory } = manifest as { stagingDirectory: string };

  await mkdir(join(stagingDirectory, 'pr/run-a'), { recursive: true });
  await writeFile(join(stagingDirectory, 'pr/run-a/body.md'), 'edited\n');

  const { stagedPaths: _stagedPaths, ...versionTwo } = manifest;

  await writeFile(manifestPath, JSON.stringify({ ...versionTwo, version: 2 }));
  await setSession([comment('on-body', 'pr/run-a/body.md')]);

  const collected = await run({ action: 'collect', directory });

  expect(collected.details).toMatchObject({
    comments: [{ path: real('pr/run-a/body.md'), content: 'on-body' }],
    edits: [{ path: real('pr/run-a/body.md'), status: 'applied' }],
  });

  expect(await readFile(real('pr/run-a/body.md'), 'utf8')).toBe('edited\n');
});
