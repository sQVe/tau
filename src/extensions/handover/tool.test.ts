import { execFile } from 'node:child_process';
import { link, mkdir, readdir, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import {
  createTemporaryBareRoot,
  createTemporaryRepository,
} from '../../../tests/gitRepository.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createHandoverTool } from './tool.js';

const prepare = async (root: string) => {
  const result = await createHandoverTool().execute(
    'call',
    { action: 'prepare' },
    undefined,
    undefined,
    noUiContext(root),
  );

  return result.details;
};

const git = async (root: string, ...commandArguments: string[]) => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd: root });

  return stdout.trim();
};

const repositories = [
  { kind: 'worktree', create: createTemporaryRepository },
  { kind: 'bare root', create: createTemporaryBareRoot },
];

it.each(repositories)('prepares and reuses handovers in a $kind', async ({ create }) => {
  const root = await create(onTestFinished);

  const prepared = await prepare(root);

  expect(prepared.directory).toBe(join(root, '.tau', 'handovers'));
  expect((await stat(prepared.directory)).isDirectory()).toBe(true);
  expect(await readFile(join(root, '.tau', '.gitignore'), 'utf8')).toMatch(/\*\n$/);
  expect(await prepare(root)).toEqual(prepared);
});

it('prepares at the checkout root from a nested directory', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const nested = join(root, 'nested');

  await mkdir(nested);

  expect(await prepare(nested)).toEqual({ directory: join(root, '.tau', 'handovers') });
});

it('prepares at the bare root from a nested directory', async () => {
  const root = await createTemporaryBareRoot(onTestFinished);
  const nested = join(root, 'nested');

  await mkdir(nested);

  expect(await prepare(nested)).toEqual({ directory: join(root, '.tau', 'handovers') });
});

it.each(['missing', 'directory', 'malformed', 'different target', 'missing target'])(
  'prepares in a plain bare Git directory when the parent .git is %s',
  async (kind) => {
    const container = await createTemporaryBareRoot(onTestFinished);
    const gitFile = join(container, '.git');
    const root = join(container, 'plain.git');
    const nested = join(root, 'nested');

    await git(container, 'init', '--bare', root);
    await unlink(gitFile);

    if (kind === 'directory') {
      await mkdir(gitFile);
    }

    if (kind === 'malformed') {
      await writeFile(gitFile, 'not a Git directory pointer\n');
    }

    if (kind === 'different target') {
      await writeFile(gitFile, 'gitdir: .bare\n');
    }

    if (kind === 'missing target') {
      await writeFile(gitFile, 'gitdir: absent\n');
    }

    await mkdir(nested);

    expect(await prepare(nested)).toEqual({ directory: join(root, '.tau', 'handovers') });
    expect(await readdir(nested)).toEqual([]);
  },
);

it('matches the bare root Git file through a symlink target', async () => {
  const root = await createTemporaryBareRoot(onTestFinished);
  const nested = join(root, 'nested');

  await symlink(join(root, '.bare'), join(root, 'git-alias'));
  await writeFile(join(root, '.git'), 'gitdir: git-alias\n');
  await mkdir(nested);

  expect(await prepare(nested)).toEqual({ directory: join(root, '.tau', 'handovers') });
});

it.each(repositories)('refuses symlinks in a $kind without outside writes', async ({ create }) => {
  const root = await create(onTestFinished);
  const outside = await createTemporaryRepository(onTestFinished);

  await symlink(outside, join(root, '.tau'));
  const before = await readdir(outside);

  await expect(prepare(root)).rejects.toThrow(/symlink/);

  expect(await readdir(outside)).toEqual(before);
});

it.each(repositories)(
  'refuses a hard-linked ignore file in a $kind without changing outside bytes',
  async ({ create }) => {
    const root = await create(onTestFinished);
    const outside = await createTemporaryRepository(onTestFinished);
    const outsideFile = join(outside, 'ignore');

    await writeFile(outsideFile, 'outside bytes\n');
    await mkdir(join(root, '.tau'));
    await link(outsideFile, join(root, '.tau', '.gitignore'));

    await expect(prepare(root)).rejects.toThrow(/hard link/);

    expect(await readFile(outsideFile, 'utf8')).toBe('outside bytes\n');
    expect(await readdir(join(root, '.tau'))).toEqual(['.gitignore']);
  },
);

it('refuses a tracked destination without changing it', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = join(root, '.tau', 'handovers');
  const message = join(directory, 'message.md');

  await mkdir(directory, { recursive: true });
  await writeFile(message, 'tracked message\n');
  await git(root, 'add', '--force', message);

  await expect(prepare(root)).rejects.toThrow(/Git tracks files in .tau\/handovers/);

  expect(await readFile(message, 'utf8')).toBe('tracked message\n');
  expect(await readdir(join(root, '.tau'))).toEqual(['handovers']);
});

it('overrides a later ignore exception in a worktree', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const ignoreFile = join(root, '.tau', '.gitignore');

  await mkdir(join(root, '.tau'));
  await writeFile(ignoreFile, '*\n!handovers/\n!handovers/message.md\n');

  await prepare(root);

  expect(await readFile(ignoreFile, 'utf8')).toMatch(/\*\n$/);

  expect(await git(root, 'check-ignore', '--', '.tau/handovers/message.md')).toBe(
    '.tau/handovers/message.md',
  );
});

it('refuses a later ignore exception in a bare root without changing it', async () => {
  const root = await createTemporaryBareRoot(onTestFinished);
  const ignoreFile = join(root, '.tau', '.gitignore');
  const content = '*\n!handovers/message.md\n';

  await mkdir(join(root, '.tau'));
  await writeFile(ignoreFile, content);

  await expect(prepare(root)).rejects.toThrow(/exception follows/);

  expect(await readFile(ignoreFile, 'utf8')).toBe(content);
  expect(await readdir(join(root, '.tau'))).toEqual(['.gitignore']);
});
