import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { nodeExecutable } from './resolution.js';

describe('nodeExecutable', () => {
  it('ignores a directory named node on PATH', async () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-node-');

    onTestFinished(async () => {
      vi.unstubAllEnvs();
    });

    await mkdir(join(directory, 'node'));
    vi.stubEnv('PATH', directory);

    expect(nodeExecutable('/usr/bin/nodejs')).toBe('/usr/bin/nodejs');
  });

  it.each(['node', 'nodejs'])('finds %s on PATH for a compiled agent', async (name) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-node-');

    onTestFinished(async () => {
      vi.unstubAllEnvs();
    });

    const executable = join(directory, name);

    await writeFile(executable, '');
    await chmod(executable, 0o755);

    vi.stubEnv('PATH', directory);

    expect(nodeExecutable('/usr/bin/pi')).toBe(executable);
    expect(nodeExecutable('/opt/pi-coding-agent/pi')).toBe(executable);
  });

  it('skips a node file on PATH that is not executable', async () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-node-');

    onTestFinished(async () => {
      vi.unstubAllEnvs();
    });

    const plain = join(directory, 'plain');
    const runnable = join(directory, 'runnable');

    await mkdir(plain);
    await mkdir(runnable);
    await writeFile(join(plain, 'node'), '');
    await writeFile(join(runnable, 'node'), '');
    await chmod(join(runnable, 'node'), 0o755);

    vi.stubEnv('PATH', [plain, runnable].join(delimiter));

    expect(nodeExecutable('/usr/bin/pi')).toBe(join(runnable, 'node'));
  });

  it.for(['/opt/bin/mynode', '/opt/bin/node-agent'])(
    'looks up node on PATH for the agent executable %s',
    async (executablePath) => {
      const directory = temporaryDirectory(onTestFinished, 'tau-node-');

      onTestFinished(async () => {
        vi.unstubAllEnvs();
      });

      const executable = join(directory, 'node');

      await writeFile(executable, '');
      await chmod(executable, 0o755);

      vi.stubEnv('PATH', directory);

      expect(nodeExecutable(executablePath)).toBe(executable);
    },
  );

  it('keeps a node executable regardless of PATH', async () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-node-');

    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    const executable = join(directory, 'node');

    await writeFile(executable, '');
    await chmod(executable, 0o755);

    vi.stubEnv('PATH', directory);

    expect(nodeExecutable('/usr/bin/node')).toBe('/usr/bin/node');
  });

  it('keeps a nonstandard node name when no node command resolves', () => {
    vi.stubEnv('PATH', '');

    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    expect(nodeExecutable('/usr/bin/nodejs')).toBe('/usr/bin/nodejs');
  });
});
