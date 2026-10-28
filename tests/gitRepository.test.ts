import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, vi } from 'vitest';

import { createTemporaryRepository, git } from './gitRepository.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const executeFile = promisify(execFile);

it('returns Git stdout with its leading space and without the trailing newline', async ({
  onTestFinished,
}) => {
  const repositoryDirectory = await createTemporaryRepository(onTestFinished);
  await writeFile(join(repositoryDirectory, 'file.txt'), 'content\n');
  await executeFile('git', ['add', 'file.txt'], { cwd: repositoryDirectory });
  await executeFile('git', ['commit', '-m', 'test: commit'], { cwd: repositoryDirectory });
  await writeFile(join(repositoryDirectory, 'file.txt'), 'changed\n');

  const output = await git(repositoryDirectory, 'status', '--porcelain');

  expect(output).toBe(' M file.txt');
});

it('rejects when Git exits nonzero', async ({ onTestFinished }) => {
  const repositoryDirectory = await createTemporaryRepository(onTestFinished);

  await expect(git(repositoryDirectory, 'rev-parse', 'nope')).rejects.toThrow(
    "ambiguous argument 'nope'",
  );
});

it('ignores a hostile user Git configuration, also for Git calls the code under test makes', async ({
  onTestFinished,
}) => {
  const home = temporaryDirectory(onTestFinished, 'tau-hostile-home-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  await mkdir(join(home, 'hooks'));
  await writeFile(join(home, 'hooks/pre-commit'), '#!/bin/sh\nexit 1\n');
  await chmod(join(home, 'hooks/pre-commit'), 0o755);

  await writeFile(
    join(home, '.gitconfig'),
    `[init]\n\tdefaultBranch = hostile\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n[core]\n\thooksPath = ${join(home, 'hooks')}\n`,
  );

  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));

  const repositoryDirectory = await createTemporaryRepository(onTestFinished);
  await writeFile(join(repositoryDirectory, 'file.txt'), 'content\n');
  // No explicit environment: production code calls Git the same way.
  await executeFile('git', ['add', 'file.txt'], { cwd: repositoryDirectory });
  await executeFile('git', ['commit', '-m', 'test: commit'], { cwd: repositoryDirectory });

  const { stdout } = await executeFile('git', ['log', '-1', '--format=%D|%an|%ae|%aI|%G?'], {
    cwd: repositoryDirectory,
  });

  expect(stdout.trim()).toBe('HEAD -> main|Tau Test|tau@example.com|2005-04-07T22:13:13Z|N');
});
