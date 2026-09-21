import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, vi } from 'vitest';

import { createTemporaryRepository } from './gitRepository.js';

const executeFile = promisify(execFile);

it('ignores a hostile user Git configuration, also for Git calls the code under test makes', async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), 'tau-hostile-home-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
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
