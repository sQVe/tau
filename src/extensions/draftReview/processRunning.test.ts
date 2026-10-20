import { spawnSync } from 'node:child_process';

import { expect, it } from 'vitest';

import { isProcessRunning } from './processRunning.js';

const runningAsRoot = process.getuid?.() === 0;

it('counts the current process as running', () => {
  expect(isProcessRunning(process.pid)).toBe(true);
});

it('counts an exited child as gone', () => {
  const child = spawnSync(process.execPath, ['-e', '']);

  expect(child.pid).toBeGreaterThan(0);
  expect(isProcessRunning(child.pid)).toBe(false);
});

it.skipIf(runningAsRoot)('counts a process it may not signal as running', () => {
  expect(isProcessRunning(1)).toBe(true);
});
