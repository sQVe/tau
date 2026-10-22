import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';

export interface GitOverride {
  // A text that the call's arguments, joined with spaces and padded with one space on each side, hold.
  match: string;
  // Shell commands that run in place of Git. $git is the path of the real Git. The call ends with
  // exit 0 unless the script exits first.
  script: string;
}

// Puts a `git` script first on PATH for the rest of the test. A call that matches an override runs
// the override's script; every other call runs the real Git.
export const installFakeGit = async (overrides: GitOverride[]): Promise<void> => {
  const directory = temporaryDirectory(onTestFinished, 'tau-fake-git-');

  const { stdout } = await promisify(execFile)('sh', ['-c', 'command -v git']);

  const cases = overrides.map(({ match, script }) => `*"${match}"*) ${script}; exit 0 ;;`);

  const lines = [
    '#!/bin/sh',
    `git='${stdout.trim()}'`,
    'case " $* " in',
    ...cases,
    'esac',
    'exec "$git" "$@"',
  ];

  await writeFile(join(directory, 'git'), `${lines.join('\n')}\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${directory}:${process.env['PATH'] ?? ''}`);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
};
