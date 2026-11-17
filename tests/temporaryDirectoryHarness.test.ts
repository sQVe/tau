import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const harnessUrl = pathToFileURL(join(import.meta.dirname, 'temporaryDirectoryHarness.ts')).href;

const runChild = async (source: string): Promise<string> => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '--eval',
    source,
  ]);

  return stdout.trim();
};

const startChild = async (source: string): Promise<{ child: ChildProcess; directory: string }> => {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const directory = await new Promise<string>((resolve, reject) => {
    let output = '';

    child.stdout.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      output += chunk;

      if (output.includes('\n')) {
        resolve(output.trim());
      }
    });

    child.once('error', reject);

    child.once('exit', (code) => {
      reject(new Error(`Child exited before it reported its directory: ${String(code)}`));
    });
  });

  return { child, directory };
};

it('removes the directory when the registered cleanup runs', () => {
  const cleanups: (() => void)[] = [];

  const directory = temporaryDirectory((cleanup) => cleanups.push(cleanup), 'tau-harness-');

  expect(existsSync(directory)).toBe(true);

  for (const cleanup of cleanups) {
    cleanup();
  }

  expect(existsSync(directory)).toBe(false);
});

it('removes a tracked directory when the process exits before cleanup runs', async ({
  onTestFinished,
}) => {
  const directory = await runChild(
    `import { temporaryDirectory } from ${JSON.stringify(harnessUrl)}; process.stdout.write(temporaryDirectory(() => {}, 'tau-harness-exit-'));`,
  );

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  expect(existsSync(directory)).toBe(false);
});

it('removes a tracked directory when another process sends SIGTERM', async ({ onTestFinished }) => {
  const { child, directory } = await startChild(
    `import { temporaryDirectory } from ${JSON.stringify(harnessUrl)}; const directory = temporaryDirectory(() => {}, 'tau-harness-signal-'); process.stdout.write(directory + '\\n'); setInterval(() => {}, 1000);`,
  );

  onTestFinished(() => {
    child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  });

  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once('exit', (_code, signal) => {
      resolve(signal);
    });
  });

  child.kill('SIGTERM');

  expect(await exited).toBe('SIGTERM');
  expect(existsSync(directory)).toBe(false);
});
