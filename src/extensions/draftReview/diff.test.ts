import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { diffFiles } from './diff.js';

const directoryWithFiles = async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-diff-');

  await writeFile(join(directory, 'one.md'), 'one\n');
  await writeFile(join(directory, 'two.md'), 'two\n');

  return directory;
};

it('gives the hunks of two files that differ', async () => {
  const directory = await directoryWithFiles();
  const diff = await diffFiles(join(directory, 'one.md'), join(directory, 'two.md'), 'x.md');

  expect(diff).toBe('--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-one\n+two\n');
});

it('gives no hunks for equal files', async () => {
  const directory = await directoryWithFiles();
  const diff = await diffFiles(join(directory, 'one.md'), join(directory, 'one.md'), 'x.md');

  expect(diff).toBe('--- a/x.md\n+++ b/x.md\n');
});

it('fails with the git error when git itself fails', async () => {
  const directory = await directoryWithFiles();

  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'diff.algorithm');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'unknown');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const failed = diffFiles(join(directory, 'one.md'), join(directory, 'two.md'), 'x.md');

  await expect(failed).rejects.toThrow('git diff --no-index failed:');
});

const lines = (marker: string) => `${['a', 'b', 'c', marker, 'd', 'e', 'f'].join('\n')}\n`;

it('ignores the repository an inherited GIT_DIR selects', async () => {
  const directory = await directoryWithFiles();

  await writeFile(join(directory, 'one.md'), lines('one'));
  await writeFile(join(directory, 'two.md'), lines('two'));

  const expected = await diffFiles(join(directory, 'one.md'), join(directory, 'two.md'), 'x.md');
  const other = await createTemporaryRepository(onTestFinished);

  await promisify(execFile)('git', ['config', 'diff.context', '0'], { cwd: other });
  vi.stubEnv('GIT_DIR', join(other, '.git'));
  vi.stubEnv('GIT_INDEX_FILE', join(other, '.git', 'index'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const actual = await diffFiles(join(directory, 'one.md'), join(directory, 'two.md'), 'x.md');

  expect(actual).toBe(expected);
  expect(expected).toContain(' a\n');
});
