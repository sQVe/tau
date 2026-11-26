import { execFile } from 'node:child_process';
import { link, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { readRunFile } from '../prRun.js';

const execFileAsync = promisify(execFile);

it('refuses to read a symlink even after a path check', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-publish-read-');
  const outside = temporaryDirectory(onTestFinished, 'tau-publish-outside-');
  const path = join(directory, 'comment.md');

  await writeFile(join(outside, 'comment.md'), 'Outside bytes.\n');
  await symlink(join(outside, 'comment.md'), path);

  await expect(readRunFile(path)).rejects.toThrow(/ELOOP/u);
});

it('refuses to read a file with another hard link', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-publish-read-');
  const outside = temporaryDirectory(onTestFinished, 'tau-publish-outside-');
  const path = join(directory, 'comment.md');

  await writeFile(join(outside, 'comment.md'), 'Outside bytes.\n');
  await link(join(outside, 'comment.md'), path);

  await expect(readRunFile(path)).rejects.toThrow(
    'Refusing to read through a file with another hard link',
  );
});

it('refuses to read a FIFO without waiting for a writer', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-publish-read-');
  const path = join(directory, 'comment.md');

  await execFileAsync('mkfifo', [path]);

  await expect(readRunFile(path)).rejects.toThrow(
    'Refusing to read a path that is not a regular file',
  );
});
