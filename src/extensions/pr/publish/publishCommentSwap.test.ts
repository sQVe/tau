import { execFile } from 'node:child_process';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { readPublicationBytes } from './publishPlan.js';

const runFile = promisify(execFile);

it('refuses to read a symlink even after a path check', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-publish-read-');
  const outside = temporaryDirectory(onTestFinished, 'tau-publish-outside-');
  const path = join(directory, 'comment.md');

  await writeFile(join(outside, 'comment.md'), 'Outside bytes.\n');
  await symlink(join(outside, 'comment.md'), path);

  await expect(readPublicationBytes(path)).rejects.toThrow(/ELOOP/u);
});

it('refuses to read a FIFO without waiting for a writer', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-publish-read-');
  const path = join(directory, 'comment.md');

  await runFile('mkfifo', [path]);

  await expect(readPublicationBytes(path)).rejects.toThrow(
    'Refusing to read a path that is not a regular file',
  );
});
