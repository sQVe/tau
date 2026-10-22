import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../tests/gitRepository.js';
import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.js';
import { findCheckoutRoot, readGit, runGit } from './git.js';

it('resolves a null exit code when Git runs past the timeout', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-git-shim-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  // `exec` replaces the shell, so the kill reaches the process that holds the output pipe.
  writeFileSync(join(directory, 'git'), '#!/bin/sh\nexec sleep 30\n');
  chmodSync(join(directory, 'git'), 0o755);
  vi.stubEnv('PATH', `${directory}${delimiter}${process.env['PATH'] ?? ''}`);

  const result = await runGit(directory, ['remote', 'get-url', 'origin'], {
    timeoutMilliseconds: 50,
  });

  expect(result.exitCode).toBeNull();
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
  const result = await runGit(directory, ['cat-file', '--batch'], { input });

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

it('resolves a null exit code with the reason when Git cannot start', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-git-missing-');
  const missing = join(directory, 'absent');

  const result = await runGit(missing, ['status']);

  expect(result.exitCode).toBeNull();
  expect(result.stderr).toContain('ENOENT');
});

it('resolves a null exit code when the signal aborts Git', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const result = await runGit(root, ['status'], { signal: AbortSignal.abort() });

  expect(result.exitCode).toBeNull();
});

it('adds the environment on top of the scrubbed one', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const other = await createTemporaryRepository(onTestFinished);

  vi.stubEnv('GIT_DIR', join(other, '.git'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const result = await runGit(root, ['rev-parse', '--show-toplevel'], {
    environment: { GIT_OPTIONAL_LOCKS: '0' },
  });

  expect(result.stdout.toString('utf8').trim()).toBe(realpathSync(root));
});

it('resolves the trimmed output of a Git command that exits 0', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);

  await expect(readGit(root, ['rev-parse', '--is-inside-work-tree'])).resolves.toBe('true');
});

it('throws with the Git message when Git exits nonzero', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-git-shim-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  writeFileSync(join(directory, 'git'), '#!/bin/sh\necho "boom" >&2\nexit 128\n');
  chmodSync(join(directory, 'git'), 0o755);
  vi.stubEnv('PATH', `${directory}${delimiter}${process.env['PATH'] ?? ''}`);

  await expect(readGit(directory, ['fsck'])).rejects.toThrow('git fsck failed: boom');
});

it('throws when Git cannot start', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-git-missing-');

  await expect(readGit(join(directory, 'absent'), ['status'])).rejects.toThrow('ENOENT');
});

it.for([0, 1])(
  'resolves a null exit code with a timeout reason when Git exits with %s after SIGTERM',
  async (exitCode, { onTestFinished }) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-git-shim-');

    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    writeFileSync(
      join(directory, 'git'),
      `#!/bin/sh\ntrap "exit ${exitCode}" TERM\nwhile :; do sleep 0.05; done\n`,
    );

    chmodSync(join(directory, 'git'), 0o755);
    vi.stubEnv('PATH', `${directory}${delimiter}${process.env['PATH'] ?? ''}`);

    const result = await runGit(directory, ['status'], { timeoutMilliseconds: 300 });

    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain('timed out');
  },
);

it('resolves a null exit code for an argument that holds a NUL byte', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const result = await runGit(root, ['rev-parse', 'HEAD:bad\0path']);

  expect(result.exitCode).toBeNull();
  expect(result.stderr).not.toBe('');
});

it('resolves a null exit code for a timeout Node rejects', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const result = await runGit(root, ['status'], { timeoutMilliseconds: -1 });

  expect(result.exitCode).toBeNull();
});
