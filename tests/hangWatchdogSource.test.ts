import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { expect, it, onTestFinished } from 'vitest';

import { watchdogSource } from './hangWatchdogSource.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const killProcess = (processId: number) => {
  if (processId <= 0) {
    return;
  }

  try {
    process.kill(processId, 'SIGKILL');
  } catch {
    // Already gone.
  }
};

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

// The reader sees a budget lowered after silence that was valid under the longer budget. It must
// treat that change as progress instead of applying the shorter budget to the earlier silence.
const startWatchdog = () => {
  const state = new Int32Array(new SharedArrayBuffer(12));
  const kills: { processId: number; signal: string }[] = [];
  let clock = 0;
  let tick: (() => void) | undefined;

  Atomics.store(state, 1, 1500);

  const context = {
    Atomics,
    Buffer,
    Int32Array,
    Uint8Array,
    performance: { now: () => clock },
    process: {
      pid: 4242,
      ppid: 1000,
      platform: 'linux',
      kill: (processId: number, signal: string) => {
        kills.push({ processId, signal });
      },
    },
    require: (specifier: string) => {
      if (specifier === 'node:worker_threads') {
        return {
          workerData: {
            state: state.buffer,
            label: new SharedArrayBuffer(8),
            parent: 1000,
          },
        };
      }

      if (specifier === 'node:fs') {
        return {
          readdirSync: () => [],
          readFileSync: () => {
            throw new Error('The watchdog must not read /proc when it lists no processes.');
          },
          writeSync: () => {},
        };
      }

      throw new Error(`Unexpected require: ${specifier}`);
    },
    setInterval: (callback: () => void) => {
      tick = callback;
    },
  };

  runInNewContext(watchdogSource, context);

  if (tick === undefined) {
    throw new Error('The watchdog did not register its interval.');
  }

  const interval = tick;

  return {
    state,
    kills,
    tickAt: (now: number) => {
      clock = now;
      interval();
    },
  };
};

it('treats a lowered blocking budget as progress before it times out', () => {
  const watchdog = startWatchdog();

  watchdog.tickAt(1000);
  expect(watchdog.kills).toEqual([]);

  Atomics.store(watchdog.state, 1, 600);

  watchdog.tickAt(1050);
  expect(watchdog.kills).toEqual([]);

  watchdog.tickAt(1649);
  expect(watchdog.kills).toEqual([]);

  watchdog.tickAt(1650);
  expect(watchdog.kills).toEqual([{ processId: 4242, signal: 'SIGKILL' }]);
});

// Descendants are found through /proc, so other platforms kill only the fork.
it.skipIf(process.platform !== 'linux')(
  'kills a blocked fork and its descendants after its parent is killed',
  async () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-watchdog-');
    const file = join(directory, 'pids');

    const parent = spawn(process.execPath, ['-e', parentScript, file], { stdio: 'ignore' });

    parent.on('error', () => {
      // The missing pid check below reports the spawn failure.
    });

    const parentId = parent.pid;

    if (parentId === undefined) {
      throw new Error('Failed to spawn the watchdog parent process.');
    }

    let pids: number[] = [];

    onTestFinished(() => {
      for (const processId of [parentId, ...pids]) {
        killProcess(processId);
      }
    });

    await waitFor(async () => (await readProcessIds(file)).length === 2);
    pids = await readProcessIds(file);

    killProcess(parentId);

    await waitFor(() => pids.every((processId) => !processIsAlive(processId)));

    expect(pids.map(processIsAlive)).toEqual([false, false]);
  },
);
