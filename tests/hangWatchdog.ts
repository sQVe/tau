import { url } from 'node:inspector';
import { setInterval } from 'node:timers';
import { Worker } from 'node:worker_threads';

import { afterAll, beforeAll, beforeEach, expect, onTestFinished } from 'vitest';

interface WorkerState {
  config: { testTimeout: number; hookTimeout: number };
}

// Vitest fails async hangs through its own timeouts. It cannot stop a blocked event loop or a file
// whose collection never finishes, so a watchdog thread kills the worker in those two cases.
// The heartbeat uses the real timer from node:timers because tests may fake the global one, and
// only the watchdog thread reads the clock.
const defaultCollectionMilliseconds = 30_000;
const slackMilliseconds = 1000;
const heartbeatMilliseconds = 100;
const maxMilliseconds = 2 ** 31 - 1;

// state[0]: heartbeat counter. state[1]: blocking budget, 0 for none. state[2]: collection
// deadline, 0 once collection has finished.
const watchdogSource = `
const { workerData } = require('node:worker_threads');
const { writeSync } = require('node:fs');
const state = new Int32Array(workerData.state);
const label = new Uint8Array(workerData.label);
const startedAt = performance.now();
let lastBeat = Atomics.load(state, 0);
let lastChange = startedAt;
const kill = (reason) => {
  const length = label.indexOf(0);
  const name = Buffer.from(label.slice(0, length < 0 ? label.length : length)).toString();
  writeSync(2, 'Hang in ' + name + ' ' + reason + '. Killing the worker.\\n');
  process.kill(process.pid, 'SIGKILL');
};
setInterval(() => {
  const now = performance.now();
  const collection = Atomics.load(state, 2);
  if (collection !== 0 && now - startedAt >= collection) {
    kill('did not finish collecting before its deadline');
  }
  const beat = Atomics.load(state, 0);
  const budget = Atomics.load(state, 1);
  if (beat !== lastBeat || budget === 0) {
    lastBeat = beat;
    lastChange = now;
    return;
  }
  if (now - lastChange >= budget) {
    kill('blocked the event loop past its timeout');
  }
}, 50);
`;

const state = new Int32Array(new SharedArrayBuffer(12));
const label = new Uint8Array(new SharedArrayBuffer(1024));

const setLabel = (name: string) => {
  const bytes = new TextEncoder().encode(name).slice(0, label.length - 1);
  label.fill(0);
  label.set(bytes);
};

const isInspecting = () =>
  url() !== undefined || process.execArgv.some((argument) => argument.startsWith('--inspect'));

const readConfig = (): WorkerState['config'] => {
  // oxlint-disable-next-line no-underscore-dangle -- Vitest exposes no public timeout settings.
  const worker = (globalThis as { __vitest_worker__?: WorkerState }).__vitest_worker__;

  return worker?.config ?? { testTimeout: 0, hookTimeout: 0 };
};

const runningTests = new Map<string, { name: string; timeout: number }>();

// A timeout of 0 on any running test disables the deadline while it runs.
const blockingBudget = () => {
  const testTimeouts = [...runningTests.values()].map((test) => test.timeout);
  const timeouts = [readConfig().hookTimeout, ...testTimeouts];
  const longest = Math.max(...timeouts);

  return timeouts.includes(0) ? 0 : Math.min(longest + slackMilliseconds, maxMilliseconds);
};

const beat = () => {
  Atomics.add(state, 0, 1);
};

const testPath = () => expect.getState().testPath ?? 'unknown file';

if (!isInspecting()) {
  const watchdog = new Worker(watchdogSource, {
    eval: true,
    workerData: { state: state.buffer, label: label.buffer },
  });

  watchdog.unref();

  const collectionMilliseconds =
    Number(process.env.TAU_COLLECTION_TIMEOUT_MS) || defaultCollectionMilliseconds;

  Atomics.store(state, 2, collectionMilliseconds);
  setLabel(`${testPath()} (collecting)`);

  const heartbeat = setInterval(beat, heartbeatMilliseconds);

  heartbeat.unref();

  const applyRunning = () => {
    Atomics.store(state, 1, blockingBudget());

    const names = [...runningTests.values()].map((test) => test.name).join(', ');

    setLabel(`${testPath()} > ${names}`);
    beat();
  };

  beforeAll(() => {
    Atomics.store(state, 2, 0);
    Atomics.store(state, 1, blockingBudget());
    setLabel(`${testPath()} (beforeAll hooks)`);
    beat();
  });

  beforeEach((context) => {
    const { task } = context;

    runningTests.set(task.id, { name: task.name, timeout: task.timeout });
    applyRunning();

    onTestFinished(() => {
      runningTests.delete(task.id);

      if (runningTests.size > 0) {
        applyRunning();

        return;
      }

      Atomics.store(state, 1, blockingBudget());
      setLabel(`${testPath()} (cleanup)`);
      beat();
    });
  });

  afterAll(() => {
    setLabel(`${testPath()} (afterAll hooks and cleanup)`);
  });
}
