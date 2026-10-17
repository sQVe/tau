import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { captureTarget, pinTarget } from './reviewCapture.js';
import type { DirectReviewTarget } from './reviewCapture.js';

const git = async (root: string, ...commandArguments: string[]) => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd: root });

  return stdout.trim();
};

const committedRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await mkdir(join(root, 'other'));
  await writeFile(join(root, 'a.txt'), 'alpha\n');
  await writeFile(join(root, 'other', 'b.txt'), 'beta\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');

  return root;
};

// Removes a loose object, so Git reports it as missing.
const deleteObject = async (root: string, name: string) => {
  const object = join(root, '.git', 'objects', name.slice(0, 2), name.slice(2));

  await rm(object, { force: true });
};

const captureOf = async (root: string, target: DirectReviewTarget) => {
  const pinned = await pinTarget(root, target);

  return captureTarget(root, pinned);
};

it('captures a root commit although the index is corrupt', async () => {
  const root = await committedRepository();

  await writeFile(join(root, '.git', 'index'), 'not an index');

  const result = await captureOf(root, { kind: 'rootCommit', commit: 'HEAD' });
  const text = result.bytes.toString('utf8');

  expect(result.errors).toEqual([]);
  expect(result.paths).toEqual(['a.txt', 'other/b.txt']);
  expect(text).toContain('+alpha');
  expect(text).toContain('+beta');
});

it('captures a named unchanged file although an unrelated subtree object is missing', async () => {
  const root = await committedRepository();

  await deleteObject(root, await git(root, 'rev-parse', 'HEAD:other'));

  const result = await captureOf(root, { kind: 'files', paths: ['a.txt'] });
  const text = result.bytes.toString('utf8');

  expect(result.errors).toEqual([]);
  expect(result.paths).toEqual(['a.txt']);
  expect(result.gaps).toEqual([]);
  expect(text).toContain('+alpha');
});

it('captures a named unchanged indexed file although its base blob is missing', async () => {
  const root = await committedRepository();

  await deleteObject(root, await git(root, 'rev-parse', 'HEAD:a.txt'));

  const result = await captureOf(root, { kind: 'files', paths: ['a.txt'] });
  const text = result.bytes.toString('utf8');

  expect(result.errors).toEqual([]);
  expect(result.paths).toEqual(['a.txt']);
  expect(result.gaps).toEqual([]);
  expect(text).toContain('+alpha');
});
