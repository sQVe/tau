import type { PathLike } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { stageReview } from './stage.js';

const copyState = vi.hoisted(() => ({ failOn: '' }));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    copyFile: async (from: PathLike, to: PathLike) => {
      if (copyState.failOn !== '' && String(from).endsWith(copyState.failOn)) {
        throw new Error('copy failed');
      }

      return actual.copyFile(from, to);
    },
  };
});

const fixture = async () => {
  const repository = await createTemporaryRepository(onTestFinished, 'tau-stage-failure-repo-');
  const data = await mkdtemp(join(tmpdir(), 'tau-stage-failure-data-'));
  onTestFinished(() => rm(data, { recursive: true, force: true }));
  vi.stubEnv('TMPDIR', data);

  onTestFinished(() => {
    vi.unstubAllEnvs();
    copyState.failOn = '';
  });

  await mkdir(join(repository, '.tau/slices'), { recursive: true });
  await writeFile(join(repository, '.tau/slices/a.md'), 'one\n');
  await writeFile(join(repository, '.tau/slices/b.md'), 'two\n');

  return { repository, data };
};

it('rethrows a failed copy and leaves no record or staging directory', async () => {
  const { repository, data } = await fixture();

  copyState.failOn = 'slices/b.md';

  await expect(stageReview(repository, ['.tau/slices/a.md', '.tau/slices/b.md'])).rejects.toThrow(
    'copy failed',
  );

  expect(await readdir(join(repository, '.tau/draft-review'))).toEqual([]);
  expect(await readdir(data)).toEqual([]);
});

it('removes the record directory when the staging directory cannot be created', async () => {
  const { repository, data } = await fixture();

  vi.stubEnv('TMPDIR', join(data, 'missing'));

  await expect(stageReview(repository, ['.tau/slices/a.md'])).rejects.toThrow(/ENOENT/);
  expect(await readdir(join(repository, '.tau/draft-review'))).toEqual([]);
});
