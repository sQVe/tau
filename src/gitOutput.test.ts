import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../tests/gitRepository.js';
import { findCheckoutRoot, readGitOutput } from './gitOutput.js';

it('resolves no output when Git runs past the timeout', async ({ onTestFinished }) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-git-shim-'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
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
  const directory = mkdtempSync(join(tmpdir(), 'tau-no-checkout-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  await expect(findCheckoutRoot(directory, 'pr')).rejects.toThrow(
    `The pr tool needs a Git checkout, and ${directory} is not in one.`,
  );
});
