import { execFile } from 'node:child_process';
import type { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, vi } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import {
  createTemporaryRepository,
  executeCommit,
  writeRepositoryFile,
} from './fixtures/commitTool.js';

const lstatCalls = vi.hoisted(() => ({ failAfter: Number.POSITIVE_INFINITY, count: 0, path: '' }));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    lstat: (async (path: string) => {
      if (path === lstatCalls.path) {
        lstatCalls.count += 1;

        if (lstatCalls.count > lstatCalls.failAfter) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
      }

      return original.lstat(path);
    }) as unknown as typeof lstat,
  };
});

it('rejects a request whose path cannot be inspected for a reason other than absence', async () => {
  const directory = await createTemporaryRepository();
  await writeRepositoryFile(directory, 'file.txt', 'content');

  await expect(
    executeCommit(directory, { groups: [{ files: ['file.txt/child'], subject: 'feat: a' }] }),
  ).rejects.toThrow(/ENOTDIR/);

  expect(await git(directory, 'diff', '--cached', '--name-only')).toBe('');
});

it('stops and restores the index when a staged deletion cannot be inspected', async () => {
  const directory = await createTemporaryRepository();
  await writeRepositoryFile(directory, 'a.txt', 'one\n');
  await git(directory, 'add', 'a.txt');
  await git(directory, 'commit', '-m', 'chore: seed');
  await git(directory, 'rm', '--cached', '--quiet', 'a.txt');

  Object.assign(lstatCalls, { count: 0, failAfter: 1, path: join(directory, 'a.txt') });

  try {
    await expect(
      executeCommit(directory, { groups: [{ files: ['a.txt'], subject: 'feat: a' }] }),
    ).rejects.toThrow(/permission denied/);
  } finally {
    lstatCalls.failAfter = Number.POSITIVE_INFINITY;
  }

  expect(
    (await promisify(execFile)('git', ['rev-list', '--count', 'HEAD'], { cwd: directory })).stdout,
  ).toBe('1\n');

  expect(
    (await promisify(execFile)('git', ['diff', '--cached', '--name-status'], { cwd: directory }))
      .stdout,
  ).toBe('D\ta.txt\n');
});
