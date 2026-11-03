import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { createTemporaryBareRoot, createTemporaryRepository } from '../tests/gitRepository.js';
import { checkTauDirectory, createFreshTauDirectory, ensureTauDirectory } from './tauDirectory.js';

const isIgnored = async (repository: string, path: string) => {
  try {
    await promisify(execFile)('git', ['check-ignore', '--quiet', path], { cwd: repository });

    return true;
  } catch {
    return false;
  }
};

const listTree = async (directory: string) =>
  (await readdir(directory, { recursive: true })).toSorted();

it('prepares handovers in a bare repository root', async ({ onTestFinished }) => {
  const root = await createTemporaryBareRoot(onTestFinished);

  const directory = await ensureTauDirectory(root, 'handovers');

  expect(directory).toBe(join(root, '.tau', 'handovers'));
  expect((await lstat(directory)).isDirectory()).toBe(true);
  expect(await readFile(join(root, '.tau', '.gitignore'), 'utf8')).toMatch(/\*\n$/);

  const before = await listTree(root);
  const ignoreBefore = await readFile(join(root, '.tau', '.gitignore'), 'utf8');

  await expect(checkTauDirectory(root, 'handovers')).resolves.toBeUndefined();

  expect(await listTree(root)).toEqual(before);
  expect(await readFile(join(root, '.tau', '.gitignore'), 'utf8')).toBe(ignoreBefore);
});

it.for([
  { content: undefined, error: /final \* rule/ },
  { content: '*\n!handovers/message.md\n', error: /exception follows/ },
])(
  'checks a bare root with ignore content $content without writes',
  async ({ content, error }, { onTestFinished }) => {
    const root = await createTemporaryBareRoot(onTestFinished);
    const ignoreFile = join(root, '.tau', '.gitignore');

    await mkdir(join(root, '.tau'));

    if (content !== undefined) {
      await writeFile(ignoreFile, content);
    }

    const before = await listTree(root);

    await expect(checkTauDirectory(root, 'handovers')).rejects.toThrow(error);

    const ignoreAfter = await readFile(ignoreFile, 'utf8').catch(() => undefined);

    expect(await listTree(root)).toEqual(before);
    expect(ignoreAfter).toBe(content);
  },
);

it('creates the directory and makes Git ignore everything in .tau', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);

  const directory = await ensureTauDirectory(repository, 'slices/me-479');

  expect((await lstat(directory)).isDirectory()).toBe(true);
  expect(directory).toBe(join(repository, '.tau/slices/me-479'));
  expect(await isIgnored(repository, '.tau/slices/me-479/plan.md')).toBe(true);
  expect(await isIgnored(repository, '.tau/.gitignore')).toBe(true);
});

it('keeps existing ignore rules and adds the ignore rule once', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await mkdir(join(repository, '.tau'));
  await writeFile(join(repository, '.tau/.gitignore'), 'state.json');

  await ensureTauDirectory(repository, 'slices/me-479');
  await ensureTauDirectory(repository, 'pr');

  expect(await readFile(join(repository, '.tau/.gitignore'), 'utf8')).toBe('state.json\n*\n');
});

it('creates a new ignored directory on each fresh call', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);

  const first = await createFreshTauDirectory(repository, 'workers', 'review-');
  const second = await createFreshTauDirectory(repository, 'workers', 'review-');

  expect(first).not.toBe(second);
  expect(dirname(first)).toBe(join(repository, '.tau/workers'));
  expect(dirname(second)).toBe(join(repository, '.tau/workers'));
  expect(await isIgnored(repository, join(first, 'input.md'))).toBe(true);
});

it('overrides a .tau/.gitignore exception for a file in the target', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await mkdir(join(repository, '.tau'));

  await writeFile(
    join(repository, '.tau/.gitignore'),
    '*\n!slices/\n!slices/me-479/\n!slices/me-479/plan.json\n',
  );

  await ensureTauDirectory(repository, 'slices/me-479');

  expect(await isIgnored(repository, '.tau/slices/me-479/plan.json')).toBe(true);
});

it.for([
  { name: 'a comment line', content: '*\n# keep this\n' },
  { name: 'a whitespace-only line', content: '*\n   \n' },
])('adds no second ignore rule after $name', async ({ content }, { onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);

  await mkdir(join(repository, '.tau'));
  await writeFile(join(repository, '.tau/.gitignore'), content);
  await ensureTauDirectory(repository, 'slices');

  expect(await readFile(join(repository, '.tau/.gitignore'), 'utf8')).toBe(content);
});
