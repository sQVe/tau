import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';

const startInstall = (directory: string, name: string) => {
  const script = fileURLToPath(new URL('./fixtures/packageInstallChild.ts', import.meta.url));

  const child = spawn(
    process.execPath,
    [
      '--import',
      'jiti/register',
      script,
      directory,
      join(directory, 'windows'),
      name,
      join(directory, `${name}.observation`),
      join(directory, 'release'),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let errors = '';

  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });

  const finished = new Promise<void>((resolve, reject) => {
    child.on('error', reject);

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Install child ${name} exited ${code}: ${errors}`));
      }
    });
  });

  finished.catch(() => undefined);

  const waitWhileRunning = async <Value>(
    wait: Promise<Value>,
    expected: string,
  ): Promise<Value> => {
    const exited = finished.then(
      () => {
        throw new Error(`Install child ${name} exited 0 before ${expected}: ${errors}`);
      },
      (error: unknown) => {
        throw error;
      },
    );

    return Promise.race([wait, exited]);
  };

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  return { finished, waitWhileRunning };
};

it('serializes install windows in two processes sharing an agent directory', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-install-processes-');
  const record = join(directory, 'windows');
  const first = startInstall(directory, 'first');

  await first.waitWhileRunning(
    vi.waitFor(
      async () => {
        expect(await readFile(record, 'utf8')).toBe('start first\n');
      },
      { timeout: 10_000 },
    ),
    'recording its start',
  );

  const second = startInstall(directory, 'second');

  try {
    const observation = await second.waitWhileRunning(
      vi.waitFor(
        async () => {
          const state = await readFile(join(directory, 'second.observation'), 'utf8');

          expect(['waiting', 'entered']).toContain(state);

          return state;
        },
        { timeout: 10_000 },
      ),
      'recording its install observation',
    );

    expect(observation).toBe('waiting');
  } finally {
    await writeFile(join(directory, 'release'), 'released');
    await Promise.all([first.finished, second.finished]);
  }

  expect(await readFile(record, 'utf8')).toBe('start first\nend first\nstart second\nend second\n');
}, 25_000);
