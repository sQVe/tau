import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { createTemporaryRepository } from './gitRepository.js';
import { createHarness } from './tddHarness.js';

vi.setConfig({ testTimeout: 125_000 });

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

it('rejects unformatted files in the real hook without rewriting them', async ({
  onTestFinished,
}) => {
  const cwd = await createTemporaryRepository(onTestFinished, 'tau-staged-hook-');
  const git = (argumentsList: string[]) => promisify(execFile)('git', argumentsList, { cwd });

  await symlink(join(repositoryRoot, 'node_modules'), join(cwd, 'node_modules'), 'dir');
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await git(['config', 'core.hooksPath', '.vite-hooks']);
  await mkdir(join(cwd, '.vite-hooks'));
  await writeFile(
    join(cwd, '.vite-hooks/pre-commit'),
    `#!/bin/sh\n${await readFile(join(repositoryRoot, '.vite-hooks/pre-commit'), 'utf8')}`,
  );
  await chmod(join(cwd, '.vite-hooks/pre-commit'), 0o755);
  await writeFile(
    join(cwd, 'vite.config.ts'),
    await readFile(join(repositoryRoot, 'vite.config.ts'), 'utf8'),
  );
  await writeFile(join(cwd, 'value.json'), '{"value":1}');
  await git(['add', '--', 'value.json']);

  const commit = git(['commit', '-m', 'test: add value']);

  await expect(commit).rejects.toHaveProperty(
    'stderr',
    expect.stringMatching(/vp fmt --check.*\[FAILED\]/),
  );
  expect(await readFile(join(cwd, 'value.json'), 'utf8')).toBe('{"value":1}');
  expect((await git(['rev-list', '--all', '--count'])).stdout.trim()).toBe('0');
});

it('runs commit hooks through Pi without approval or TDD notices', async ({ onTestFinished }) => {
  const { cwd, session, call } = await createHarness(onTestFinished);
  const git = (argumentsList: string[]) => promisify(execFile)('git', argumentsList, { cwd });

  await writeFile(join(cwd, '.git/info/exclude'), 'node_modules\n');
  await git(['config', 'user.name', 'Tau Test']);
  await git(['config', 'user.email', 'tau@example.com']);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['config', 'core.hooksPath', '.vite-hooks']);
  await mkdir(join(cwd, '.vite-hooks'));
  await writeFile(
    join(cwd, '.vite-hooks/pre-commit'),
    `#!/bin/sh\n${await readFile(join(repositoryRoot, '.vite-hooks/pre-commit'), 'utf8')}`,
  );
  await chmod(join(cwd, '.vite-hooks/pre-commit'), 0o755);
  await writeFile(
    join(cwd, 'vite.config.ts'),
    "export default { staged: { '*.ts': 'vp fmt --check' } };",
  );
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;\n');

  const custom = vi.fn<() => never>(() => {
    throw new Error('Unexpected approval UI');
  });
  await session.bindExtensions({ uiContext: { custom } as unknown as ExtensionUIContext });
  const committed = await call('commit', {
    groups: [{ files: ['src/value.ts', 'package.json'], subject: 'feat: add formatted fixture' }],
  });

  expect(committed.isError && JSON.stringify(committed.result)).toBe(false);
  expect(custom).not.toHaveBeenCalled();
  expect(JSON.stringify(committed.result)).toContain('Git hooks: run');
  expect(JSON.stringify(committed.result)).not.toContain('TDD');
  expect(await readFile(join(cwd, 'src/value.ts'), 'utf8')).toBe('export const value = 1;\n');
  expect((await git(['show', 'HEAD:src/value.ts'])).stdout).toBe('export const value = 1;\n');
});
