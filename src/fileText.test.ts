import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.js';
import { readCheckedText } from './fileText.js';

const rules = { label: 'text file', byteLimit: 10 };
const mkfifo = promisify(execFile);

it('refuses a file over the limit on the read path', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-file-text-');
  const file = join(directory, 'big.txt');

  await writeFile(file, 'a'.repeat(11));

  await expect(readCheckedText(file, file, rules)).rejects.toThrow(
    'text file is larger than 10 bytes: ',
  );
});

it('reads a file at exactly the limit', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-file-text-');
  const file = join(directory, 'limit.txt');

  await writeFile(file, 'a'.repeat(10));

  await expect(readCheckedText(file, file, rules)).resolves.toBe('a'.repeat(10));
});

it('refuses a directory as not a regular file', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-file-text-');
  const file = join(directory, 'folder');

  await mkdir(file);

  await expect(readCheckedText(file, file, rules)).rejects.toThrow(
    'text file is not a regular file: ',
  );
});

it('refuses a FIFO with no writer without hanging', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-file-text-');
  const file = join(directory, 'pipe');

  await mkfifo('mkfifo', [file]);

  const outcome = await Promise.race([
    readCheckedText(file, file, rules).then(
      () => 'read',
      (error: unknown) => (error instanceof Error ? error.message : 'error'),
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve('timeout');
      }, 1000);
    }),
  ]);

  expect(outcome).toContain('text file is not a regular file:');
});
