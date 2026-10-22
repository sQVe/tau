import { existsSync } from 'node:fs';

import { expect, it } from 'vitest';

import { temporaryDirectory } from './temporaryDirectoryHarness.js';

it('removes the directory when the registered cleanup runs', () => {
  const cleanups: (() => void)[] = [];

  const directory = temporaryDirectory((cleanup) => cleanups.push(cleanup), 'tau-harness-');

  expect(existsSync(directory)).toBe(true);

  for (const cleanup of cleanups) {
    cleanup();
  }

  expect(existsSync(directory)).toBe(false);
});
