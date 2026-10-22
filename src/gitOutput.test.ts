import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../tests/gitRepository.js';
import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.js';
import { findCheckoutRoot, readGitOutput, readOptionalGit, runGit } from './gitOutput.js';

it('resolves no output when Git runs past the timeout', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-git-shim-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  // `exec` replaces the shell, so the kill reaches the process that holds the output pipe.
  writeFileSync(join(directory, 'git'), '#!/bin/sh\nexec sleep 30\n');
  chmodSync(join(directory, 'git'), 0o755);
  vi.stubEnv('PATH', `${directory}${delimiter}${process.env['PATH'] ?? ''}`);

  await expect(readGitOutput(directory, ['remote', 'get-url', 'origin'], 50)).resolves.toBe(
    undefined,
  );
});

it('finds the checkout root from a directory inside it', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const nested = join(root, 'src', 'deep');

  mkdirSync(nested, { recursive: true });

  await expect(findCheckoutRoot(nested, 'pr')).resolves.toBe(realpathSync(root));
});

it('names the tool when the directory is not in a Git checkout', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-no-checkout-');

  await expect(findCheckoutRoot(directory, 'pr')).rejects.toThrow(
    `The pr tool needs a Git checkout, and ${directory} is not in one.`,
  );
});

it('resolves the exit code when Git exits before it reads its input', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-git-shim-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  writeFileSync(join(directory, 'git'), '#!/bin/sh\nexit 3\n');
  chmodSync(join(directory, 'git'), 0o755);
  vi.stubEnv('PATH', `${directory}${delimiter}${process.env['PATH'] ?? ''}`);

  const input = 'x'.repeat(4_000_000);
  const result = await runGit(directory, ['cat-file', '--batch'], undefined, input);

  expect(result.exitCode).toBe(3);
});

it('passes the user environment to Git', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);

  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'tau.probe');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'from-environment');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const result = await runGit(root, ['config', '--get', 'tau.probe']);

  expect(result.stdout.toString('utf8').trim()).toBe('from-environment');
});

it('rejects when Git does not exit with a number', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-git-missing-');
  const missing = join(directory, 'absent');

  await expect(runGit(missing, ['status'])).rejects.toMatchObject({ code: 'ENOENT' });
});

it('resolves the trimmed output of a Git command that exits 0', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);

  await expect(readOptionalGit(root, ['rev-parse', '--is-inside-work-tree'])).resolves.toBe('true');
});

it('resolves undefined when Git exits with 1', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);

  await expect(readOptionalGit(root, ['config', '--get', 'tau.missing'])).resolves.toBeUndefined();
});

it.for([2, 128])(
  'throws with the Git message when Git exits with %s',
  async (exitCode, { onTestFinished }) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-git-shim-');

    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    writeFileSync(join(directory, 'git'), `#!/bin/sh\necho "boom" >&2\nexit ${exitCode}\n`);
    chmodSync(join(directory, 'git'), 0o755);
    vi.stubEnv('PATH', `${directory}${delimiter}${process.env['PATH'] ?? ''}`);

    await expect(readOptionalGit(directory, ['fsck'])).rejects.toThrow('git fsck failed: boom');
  },
);
