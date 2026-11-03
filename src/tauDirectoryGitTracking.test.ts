import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { createTemporaryRepository } from '../tests/gitRepository.js';
import { checkTauDirectory, ensureTauDirectory } from './tauDirectory.js';

it('refuses a tracked .tau/.gitignore before it changes anything', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  const ignoreFile = join(repository, '.tau/.gitignore');

  await mkdir(join(repository, '.tau'));
  await writeFile(ignoreFile, 'state.json\n');
  await promisify(execFile)('git', ['add', '--force', ignoreFile], { cwd: repository });

  await expect(ensureTauDirectory(repository, 'slices/me-479')).rejects.toThrow(
    'Git tracks files in .tau/.gitignore',
  );

  expect(await readFile(ignoreFile, 'utf8')).toBe('state.json\n');
  expect(await readdir(join(repository, '.tau'))).toEqual(['.gitignore']);
});

it('check refuses an exception added after the ignore rule and changes nothing', async ({
  onTestFinished,
}) => {
  const repository = await createTemporaryRepository(onTestFinished);
  const ignoreFile = join(repository, '.tau/.gitignore');

  await ensureTauDirectory(repository, 'slices/me-479');
  await writeFile(ignoreFile, '!slices/me-479/plan.json\n', { flag: 'a' });

  const before = await readFile(ignoreFile, 'utf8');

  await expect(checkTauDirectory(repository, 'slices/me-479')).rejects.toThrow('.tau/.gitignore');

  expect(await readFile(ignoreFile, 'utf8')).toBe(before);
});

it('check accepts a directory that the root .gitignore ignores without .tau/.gitignore', async ({
  onTestFinished,
}) => {
  const repository = await createTemporaryRepository(onTestFinished);

  await writeFile(join(repository, '.gitignore'), '.tau/\n');
  await mkdir(join(repository, '.tau/slices/me-479'), { recursive: true });

  await expect(checkTauDirectory(repository, 'slices/me-479')).resolves.toBeUndefined();
  expect(await readdir(join(repository, '.tau'))).toEqual(['slices']);
});

it('refuses when Git tracks a file in the target', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  const tracked = join(repository, '.tau/slices/me-479/file');

  await mkdir(dirname(tracked), { recursive: true });
  await writeFile(tracked, 'tracked\n');
  await promisify(execFile)('git', ['add', '--force', tracked], { cwd: repository });

  await expect(ensureTauDirectory(repository, 'slices/me-479')).rejects.toThrow(
    '.tau/slices/me-479',
  );

  expect(await readFile(tracked, 'utf8')).toBe('tracked\n');
  expect(await readdir(join(repository, '.tau'))).toEqual(['slices']);
  expect(await readdir(dirname(tracked))).toEqual(['file']);
});

it('refuses a tracked file in the target before it creates .tau/.gitignore', async ({
  onTestFinished,
}) => {
  const repository = await createTemporaryRepository(onTestFinished);
  const tracked = join(repository, '.tau/slices/me-479/plan.json');

  await mkdir(dirname(tracked), { recursive: true });
  await writeFile(tracked, '{}\n');
  await promisify(execFile)('git', ['add', '--force', tracked], { cwd: repository });

  await expect(ensureTauDirectory(repository, 'slices/me-479')).rejects.toThrow(
    'Git tracks files in .tau/slices/me-479',
  );

  expect(await readdir(join(repository, '.tau'))).toEqual(['slices']);
});

it('refuses when Git tracks a file in an ignored target', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  const tracked = join(repository, '.tau/slices/me-479/plan.json');

  await ensureTauDirectory(repository, 'slices/me-479');
  await writeFile(tracked, '{}\n');
  await promisify(execFile)('git', ['add', '--force', tracked], { cwd: repository });

  const ignoreBefore = await readFile(join(repository, '.tau/.gitignore'), 'utf8');

  await expect(checkTauDirectory(repository, 'slices/me-479')).rejects.toThrow(
    '.tau/slices/me-479',
  );

  expect(await readFile(tracked, 'utf8')).toBe('{}\n');
  expect(await readFile(join(repository, '.tau/.gitignore'), 'utf8')).toBe(ignoreBefore);
  expect((await readdir(join(repository, '.tau'))).toSorted()).toEqual(['.gitignore', 'slices']);
  expect(await readdir(dirname(tracked))).toEqual(['plan.json']);
});

it('check refuses a target that Git does not ignore', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);

  await mkdir(join(repository, '.tau/slices'), { recursive: true });

  await expect(checkTauDirectory(repository, 'slices')).rejects.toThrow(
    'Git does not ignore files in .tau/slices',
  );
});

it.skipIf(process.getuid?.() === 0)(
  'refuses an unreadable .tau/.gitignore and leaves it unchanged',
  async ({ onTestFinished }) => {
    const repository = await createTemporaryRepository(onTestFinished);
    const ignoreFile = join(repository, '.tau/.gitignore');

    await mkdir(join(repository, '.tau'));
    await writeFile(ignoreFile, 'state.json\n');
    await chmod(ignoreFile, 0o200);
    onTestFinished(() => chmod(ignoreFile, 0o600));

    await expect(ensureTauDirectory(repository, 'slices')).rejects.toMatchObject({
      code: 'EACCES',
    });

    await chmod(ignoreFile, 0o600);

    expect(await readFile(ignoreFile, 'utf8')).toBe('state.json\n');
  },
);
