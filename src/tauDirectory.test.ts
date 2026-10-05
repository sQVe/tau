import { execFile } from 'node:child_process';
import {
  link as hardLink,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { createTemporaryRepository } from '../tests/gitRepository.js';
import { checkTauDirectory, createFreshTauDirectory, ensureTauDirectory } from './tauDirectory.js';

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

const hardLinkedIgnoreFile = async (registerCleanup: (cleanup: () => Promise<void>) => void) => {
  const root = await createTemporaryRepository(registerCleanup);
  const outside = await createTemporaryDirectory(registerCleanup);
  const outsideFile = join(outside, 'ignore');

  await writeFile(outsideFile, 'outside bytes\n');
  await mkdir(join(root, '.tau'));
  await hardLink(outsideFile, join(root, '.tau', '.gitignore'));

  return { root, outsideFile };
};

it('refuses a hard-linked .tau/.gitignore and leaves the linked file unchanged', async ({
  onTestFinished,
}) => {
  const { root, outsideFile } = await hardLinkedIgnoreFile(onTestFinished);
  const before = await listTree(root);

  await expect(ensureTauDirectory(root, 'slices/me-479')).rejects.toThrow('hard link');

  expect(await readFile(outsideFile, 'utf8')).toBe('outside bytes\n');
  expect(await listTree(root)).toEqual(before);
});

it('check refuses a hard-linked .tau/.gitignore', async ({ onTestFinished }) => {
  const { root, outsideFile } = await hardLinkedIgnoreFile(onTestFinished);

  await writeFile(outsideFile, '*\n');

  await expect(checkTauDirectory(root, 'slices')).rejects.toThrow('hard link');
});

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

it.for([String.raw`..\outside`, String.raw`slices\me-479`])(
  'refuses the path %j with a backslash in a repository and creates nothing',
  async (path, { onTestFinished }) => {
    const repository = await createTemporaryRepository(onTestFinished);
    const before = await readdir(repository);

    await expect(ensureTauDirectory(repository, path)).rejects.toThrow(path);

    expect(await readdir(repository)).toEqual(before);
  },
);

it.for(['../review-', String.raw`..\review-`])(
  'refuses the fresh directory prefix %j with a separator and creates nothing',
  async (prefix, { onTestFinished }) => {
    const root = await createTemporaryDirectory(onTestFinished);

    await expect(createFreshTauDirectory(root, 'workers', prefix)).rejects.toThrow(prefix);

    expect(await readdir(root)).toEqual([]);
  },
);

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

  await expect(checkTauDirectory(repository, 'slices/me-479')).rejects.toThrow(
    '.tau/slices/me-479',
  );
});

it.for(['..', '.', ''])(
  'refuses the fresh directory prefix %j and creates nothing',
  async (prefix, { onTestFinished }) => {
    const root = await createTemporaryDirectory(onTestFinished);

    await expect(createFreshTauDirectory(root, 'workers', prefix)).rejects.toBeInstanceOf(Error);

    expect(await readdir(root)).toEqual([]);
  },
);
