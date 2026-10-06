import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createTemporaryRepository,
  executeCommit,
  git,
  writeRepositoryFile,
} from './fixtures/commitTool.js';

describe('commit path requests', () => {
  it.each(['.', 'sub'])('commits both paths of a staged rename from %s', async (directory) => {
    const repositoryDirectory = await createTemporaryRepository();
    const workingDirectory = join(repositoryDirectory, directory);

    await writeRepositoryFile(workingDirectory, 'old.ts', 'export const value = 1;\n');
    await git(workingDirectory, ['add', 'old.ts']);
    await git(workingDirectory, ['commit', '-m', 'feat: add source']);
    await git(workingDirectory, ['mv', 'old.ts', 'new.ts']);

    const result = await executeCommit(workingDirectory, {
      groups: [{ files: ['old.ts', 'new.ts'], subject: 'refactor: rename source' }],
    });

    const expectedFiles = ['new.ts', 'old.ts'].map((file) => join(directory, file));

    expect(result.details.groups[0]?.files).toEqual(expectedFiles);

    expect(await git(workingDirectory, ['show', 'HEAD:./new.ts'])).toBe(
      'export const value = 1;\n',
    );

    expect(await git(repositoryDirectory, ['rev-list', '--count', 'HEAD'])).toBe('2\n');
    expect(await git(repositoryDirectory, ['status', '--short'])).toBe('');
  });

  it.each(['.', 'sub'])('rejects every unknown path before staging from %s', async (directory) => {
    const repositoryDirectory = await createTemporaryRepository();
    const workingDirectory = join(repositoryDirectory, directory);

    await writeRepositoryFile(workingDirectory, 'real.ts', 'original\n');
    await git(workingDirectory, ['add', 'real.ts']);
    await git(workingDirectory, ['commit', '-m', 'feat: add source']);
    await writeRepositoryFile(workingDirectory, 'real.ts', 'changed\n');

    const indexBefore = await readFile(join(repositoryDirectory, '.git/index'));
    const headBefore = await git(repositoryDirectory, ['rev-parse', 'HEAD']);
    const statusBefore = await git(repositoryDirectory, ['status', '--short']);

    await expect(
      executeCommit(workingDirectory, {
        groups: [
          { files: ['real.ts', 'missing.ts', 'also-missing.ts'], subject: 'fix: update source' },
        ],
      }),
    ).rejects.toThrow(/Unknown paths: missing\.ts, also-missing\.ts/);

    expect(await readFile(join(repositoryDirectory, '.git/index'))).toEqual(indexBefore);
    expect(await git(repositoryDirectory, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await git(repositoryDirectory, ['status', '--short'])).toBe(statusBefore);
    expect(await readFile(join(workingDirectory, 'real.ts'), 'utf8')).toBe('changed\n');
  });

  it.each(['.', 'sub'])(
    'commits a tracked deletion that is not staged from %s',
    async (directory) => {
      const repositoryDirectory = await createTemporaryRepository();
      const workingDirectory = join(repositoryDirectory, directory);

      await writeRepositoryFile(workingDirectory, 'old.ts', 'export const value = 1;\n');
      await git(workingDirectory, ['add', 'old.ts']);
      await git(workingDirectory, ['commit', '-m', 'feat: add source']);
      await rm(join(workingDirectory, 'old.ts'));

      await executeCommit(workingDirectory, {
        groups: [{ files: ['old.ts'], subject: 'refactor: remove source' }],
      });

      expect(await git(repositoryDirectory, ['ls-tree', '--name-only', 'HEAD'])).toBe('');
      expect(await git(repositoryDirectory, ['rev-list', '--count', 'HEAD'])).toBe('2\n');
      expect(await git(repositoryDirectory, ['status', '--short'])).toBe('');
    },
  );
});
