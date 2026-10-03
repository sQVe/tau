import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { createTemporaryRepository } from '../tests/gitRepository.js';
import { createFreshTauDirectory, ensureTauDirectory } from './tauDirectory.js';

const isIgnored = async (repository: string, path: string) => {
  try {
    await promisify(execFile)('git', ['check-ignore', '--quiet', path], { cwd: repository });

    return true;
  } catch {
    return false;
  }
};

const createTemporaryDirectory = async (
  registerCleanup: (cleanup: () => Promise<void>) => void,
) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-directory-'));
  registerCleanup(() => rm(directory, { recursive: true, force: true }));

  return directory;
};

const listTree = async (directory: string) =>
  (await readdir(directory, { recursive: true })).toSorted();

const symlinkCases = [
  { name: '.tau', link: '.tau' },
  { name: 'the target directory', link: '.tau/slices/me-479' },
  { name: 'a directory between .tau and the target', link: '.tau/slices' },
  { name: '.tau/.gitignore', link: '.tau/.gitignore' },
];

for (const { name, link } of symlinkCases) {
  it(`refuses when ${name} is a symlink and creates nothing`, async ({ onTestFinished }) => {
    const root = await createTemporaryDirectory(onTestFinished);
    const outside = await createTemporaryDirectory(onTestFinished);

    await mkdir(join(root, link, '..'), { recursive: true });
    await symlink(outside, join(root, link));

    const before = await listTree(root);

    await expect(ensureTauDirectory(root, 'slices/me-479')).rejects.toThrow(link);

    expect(await listTree(root)).toEqual(before);
    expect(await readdir(outside)).toEqual([]);
    expect((await lstat(join(root, link))).isSymbolicLink()).toBe(true);
  });
}

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

it.for(['', '../outside', 'slices/../..', '/tmp/outside', 'slices//me-479'])(
  'refuses the path %j and creates nothing',
  async (path, { onTestFinished }) => {
    const root = await createTemporaryDirectory(onTestFinished);

    await expect(ensureTauDirectory(root, path)).rejects.toBeInstanceOf(Error);

    expect(await readdir(root)).toEqual([]);
  },
);

it('refuses a fresh directory prefix with a slash and creates nothing', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryDirectory(onTestFinished);

  await expect(createFreshTauDirectory(root, 'workers', '../review-')).rejects.toThrow(
    '../review-',
  );

  expect(await readdir(root)).toEqual([]);
});

it('refuses when .tau/.gitignore rules leave the target unignored', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished);
  await mkdir(join(repository, '.tau'));
  await writeFile(join(repository, '.tau/.gitignore'), '*\n!slices/\n!slices/**\n');

  await expect(ensureTauDirectory(repository, 'slices/me-479')).rejects.toThrow(
    '.tau/slices/me-479',
  );

  expect(await readdir(join(repository, '.tau'))).toEqual(['.gitignore']);
});

it.for(['..', '.', ''])(
  'refuses the fresh directory prefix %j and creates nothing',
  async (prefix, { onTestFinished }) => {
    const root = await createTemporaryDirectory(onTestFinished);

    await expect(createFreshTauDirectory(root, 'workers', prefix)).rejects.toBeInstanceOf(Error);

    expect(await readdir(root)).toEqual([]);
  },
);
