import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { readGitOutput } from './gitOutput.js';

it('resolves no output when Git runs past the timeout', async ({ onTestFinished }) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-git-shim-'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  // `exec` replaces the shell, so the kill reaches the process that holds the output pipe.
  writeFileSync(join(directory, 'git'), '#!/bin/sh\nexec sleep 30\n');
  chmodSync(join(directory, 'git'), 0o755);
  // oxlint-disable-next-line node/no-process-env -- The shim must come first on the inherited PATH.
  vi.stubEnv('PATH', `${directory}${delimiter}${process.env['PATH'] ?? ''}`);

  await expect(readGitOutput(directory, ['remote', 'get-url', 'origin'], 50)).resolves.toBe(
    undefined,
  );
});
