import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { readCompletedCapture } from '../../reviewCapture/reviewCapture.js';
import { createCodeReviewTool } from './tool.js';
import type { CodeReviewInput } from './tool.js';

const savedFiles = ['capture/patch.diff', 'capture/input.md', 'capture.json'];

const run = async (root: string, input: CodeReviewInput) => {
  const tool = createCodeReviewTool();
  const result = await tool.execute('call', input, undefined, undefined, noUiContext(root));

  return result.details;
};

const readSavedFiles = (directory: string) =>
  Promise.all(savedFiles.map((name) => readFile(join(directory, name))));

const readRecord = async (directory: string) =>
  JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as Record<string, unknown>;

const freshness = (root: string, directory: string) =>
  run(root, { action: 'freshness', directory });

const repositoryWithReview = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', 'first');

  const firstCommit = await git(root, 'rev-parse', 'HEAD');

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await git(root, 'commit', '--quiet', '-am', 'second');

  const { directory } = (await run(root, { action: 'prepare' })) as { directory: string };

  await writeFile(join(directory, 'input.md'), '# Review input\n\n## Capture\n');

  return { root, directory, firstCommit };
};

it('keeps the saved capture bytes through repeated freshness and evidence after edits', async () => {
  const { root, directory } = await repositoryWithReview();
  const originalHead = await git(root, 'rev-parse', 'HEAD');

  await writeFile(join(root, 'tracked.txt'), 'three\n');

  const captured = await run(root, {
    action: 'capture',
    directory,
    target: { kind: 'workingTree', base: 'HEAD~1' },
  });

  const saved = await readSavedFiles(directory);
  const originalRecord = await readRecord(directory);

  expect(await freshness(root, directory)).toMatchObject({ status: 'fresh' });
  expect(await readSavedFiles(directory)).toEqual(saved);

  await writeFile(join(root, 'tracked.txt'), 'four\n');

  expect(await freshness(root, directory)).toMatchObject({ status: 'stale' });
  expect(await readSavedFiles(directory)).toEqual(saved);
  expect(await readdir(directory)).toContain('recheck.diff');

  await writeFile(join(root, 'tracked.txt'), 'five\n');

  expect(await run(root, { action: 'evidence', directory })).toMatchObject({
    freshness: { status: 'stale' },
  });

  expect(await readSavedFiles(directory)).toEqual(saved);

  const record = await readRecord(directory);

  expect(record['head']).toBe(originalHead);
  expect(record['hash']).toBe(originalRecord['hash']);
  expect(record['hash']).toBe(captured['hash']);

  expect(await readCompletedCapture(root, directory)).toEqual({
    status: 'completed',
    identity: captured['identity'],
    reasons: [],
    endpoint: 'complete',
  });
});

it('reports unknown when a pinned revision cannot be read and keeps the saved capture', async () => {
  const { root, directory, firstCommit } = await repositoryWithReview();

  await writeFile(join(root, 'tracked.txt'), 'three\n');

  await run(root, {
    action: 'capture',
    directory,
    target: { kind: 'workingTree', base: firstCommit },
  });

  const saved = await readSavedFiles(directory);

  await rm(join(root, '.git', 'objects', firstCommit.slice(0, 2), firstCommit.slice(2)));

  expect(await freshness(root, directory)).toMatchObject({ status: 'unknown' });
  expect(await readdir(directory)).not.toContain('recheck.diff');
  expect(await readSavedFiles(directory)).toEqual(saved);
});
