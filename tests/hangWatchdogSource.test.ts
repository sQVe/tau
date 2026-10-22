import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { watchdogSource } from './hangWatchdogSource.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const processIsAlive = (processId: number): boolean => {
  try {
    process.kill(processId, 0);

    return true;
  } catch {
    return false;
  }
};

const waitFor = async (condition: () => Promise<boolean> | boolean): Promise<void> => {
  const deadline = Date.now() + 5000;

  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the condition.');
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
};

const readProcessIds = async (file: string): Promise<number[]> => {
  try {
    const text = await readFile(file, 'utf8');

    return text.split(',').map(Number);
  } catch {
    return [];
  }
};

// The fork starts the watchdog only after its parent died, then blocks its own event loop, like a
// Vitest fork stuck in spawn.
const forkScript = `
const { Worker } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const parent = process.ppid;
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.argv[1], process.pid + ',' + grandchild.pid);
while (process.ppid === parent) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const watchdog = new Worker(${JSON.stringify(watchdogSource)}, {
  eval: true,
  workerData: { state: new SharedArrayBuffer(12), label: new SharedArrayBuffer(8), parent },
});
watchdog.once('online', () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
`;

const parentScript = `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(forkScript)}, process.argv[1]], { stdio: ['ignore', 'ignore', 'pipe'] });
setInterval(() => {}, 1000);
`;

// Descendants are found through /proc, so other platforms kill only the fork.
it.skipIf(process.platform !== 'linux')(
  'kills a blocked fork and its descendants after its parent is killed',
  async () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-watchdog-');
    const file = join(directory, 'pids');

    const parent = spawn(process.execPath, ['-e', parentScript, file], { stdio: 'ignore' });
    const parentId = parent.pid ?? 0;

    let pids: number[] = [];

    onTestFinished(() => {
      for (const processId of [parentId, ...pids]) {
        try {
          process.kill(processId, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    });

    await waitFor(async () => (await readProcessIds(file)).length === 2);
    pids = await readProcessIds(file);

    process.kill(parentId, 'SIGKILL');

    await waitFor(() => pids.every((processId) => !processIsAlive(processId)));

    expect(pids.map(processIsAlive)).toEqual([false, false]);
  },
);
