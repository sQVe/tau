import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';

export const fixture = (): { directory: string; lockPath: string } => {
  const directory = temporaryDirectory(onTestFinished, 'tau-file-lock-');

  return { directory, lockPath: join(directory, 'locks', 'cache.lock') };
};

export const cancelled = (): Error => new Error('The operation was cancelled while it waited.');

export const heldLocks = async (lockPath: string): Promise<string[]> => {
  const directory = dirname(lockPath);
  const names = await readdir(directory).catch(() => []);
  const held: string[] = [];

  for (const name of names.filter((entry) => /\.\d+$/u.test(entry))) {
    const owner = JSON.parse(await readFile(join(directory, name), 'utf8')) as {
      released?: boolean;
    };

    if (owner.released !== true) {
      held.push(name);
    }
  }

  return held;
};

export const ownerJson = (token: string, released = false): string =>
  JSON.stringify({
    pid: process.pid,
    checkout: '/other',
    startedAt: new Date().toISOString(),
    token,
    ...(released ? { released: true } : {}),
  });
