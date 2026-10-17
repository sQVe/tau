import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { diffFiles } from './diff.js';

const directoryWithFiles = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-diff-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));
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

  await expect(failed).rejects.toMatchObject({ code: 128 });
});
