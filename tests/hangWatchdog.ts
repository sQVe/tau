import { url } from 'node:inspector';
import { clearInterval, setInterval } from 'node:timers';
import { Worker } from 'node:worker_threads';

import type { RunnerTestSuite } from 'vitest';
import { beforeAll, beforeEach, expect, TestRunner } from 'vitest';

import { watchdogSource } from './hangWatchdogSource.js';

interface WorkerState {
  config: {
    testTimeout: number;
    hookTimeout: number;
  };
}

type SuiteHook = 'beforeAll' | 'beforeEach';

interface Watchdog {
  thread: Worker;
  heartbeat: ReturnType<typeof setInterval>;
}

// Vitest fails async hangs through its own timeouts. It cannot stop a blocked event loop or a file
// whose collection never finishes, so a watchdog thread kills the worker in those two cases.
// The heartbeat uses the real timer from node:timers because tests may fake the global one, and
// only the watchdog thread reads the clock.
const defaultCollectionMilliseconds = 30_000;
const slackMilliseconds = 1000;
const heartbeatMilliseconds = 100;
const maxMilliseconds = 2 ** 31 - 1;

// Without isolation, Vitest runs this setup again for each test file in the same worker. The
// watchdog of the previous file still watches that file's state, so it stops before this file's
// watchdog starts.
const watchdogKey = Symbol.for('tau.hangWatchdog');

const watchdogs = globalThis as { [watchdogKey]?: Watchdog };

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

const hookTimeoutKey: unique symbol = Symbol.for('VITEST_CLEANUP_TIMEOUT');

type TimedHook = ((...args: never[]) => unknown) & Partial<Record<typeof hookTimeoutKey, unknown>>;

const hookTimeout = (hook: TimedHook) => {
  const timeout = hook[hookTimeoutKey];

  return typeof timeout === 'number' ? timeout : readConfig().hookTimeout;
};

const activeHooks = new Set<{ name: SuiteHook | 'cleanup'; timeout: number }>();
const runningTests = new Map<string, { name: string; timeout: number }>();

const blockingBudget = () => {
  const activeTimeouts = [...activeHooks].map((hook) => hook.timeout);
  const testTimeouts = [...runningTests.values()].map((test) => test.timeout);

  const timeouts = [readConfig().hookTimeout, ...activeTimeouts, ...testTimeouts];

  const longest = Math.max(...timeouts);

  return timeouts.includes(0) ? 0 : Math.min(longest + slackMilliseconds, maxMilliseconds);
};

const beat = () => {
  Atomics.add(state, 0, 1);
};

const testPath = () => expect.getState().testPath ?? 'unknown file';

const readCollectionMilliseconds = (value: string | undefined) => {
  if (value === undefined || value === '') {
    return defaultCollectionMilliseconds;
  }

  const milliseconds = Number(value);

  if (!Number.isInteger(milliseconds) || milliseconds <= 0 || milliseconds > maxMilliseconds) {
    throw new Error(
      `TAU_COLLECTION_TIMEOUT_MS must be a whole number of milliseconds from 1 to ${maxMilliseconds}, got "${value}".`,
    );
  }

  return milliseconds;
};

const previousWatchdog = watchdogs[watchdogKey];

if (previousWatchdog !== undefined) {
  clearInterval(previousWatchdog.heartbeat);
  await previousWatchdog.thread.terminate();
}

if (!isInspecting()) {
  const watchdog = new Worker(watchdogSource, {
    eval: true,
    workerData: { state: state.buffer, label: label.buffer, parent: process.ppid },
  });

  watchdog.unref();

  const collectionMilliseconds = readCollectionMilliseconds(process.env.TAU_COLLECTION_TIMEOUT_MS);

  Atomics.store(state, 2, collectionMilliseconds);
  setLabel(`${testPath()} (collecting)`);

  const heartbeat = setInterval(beat, heartbeatMilliseconds);

  heartbeat.unref();
  watchdogs[watchdogKey] = { thread: watchdog, heartbeat };

  const applyBudget = () => {
    Atomics.store(state, 1, blockingBudget());

    const names = [...runningTests.values()].map((test) => test.name).join(', ');
    const hasBeforeAll = [...activeHooks].some((hook) => hook.name === 'beforeAll');

    if (names) {
      setLabel(`${testPath()} > ${names}`);
    } else if (hasBeforeAll) {
      setLabel(`${testPath()} (beforeAll hooks)`);
    } else {
      setLabel(`${testPath()} (cleanup)`);
    }

    beat();
  };

  const wrapHook = <Arguments extends unknown[]>(
    hook: (...hookArguments: Arguments) => unknown,
    name: SuiteHook | 'cleanup',
    timeout: number,
  ): ((...hookArguments: Arguments) => Promise<unknown>) => {
    const wrapped = async (...hookArguments: Arguments) => {
      const active = { name, timeout };

      activeHooks.add(active);
      applyBudget();

      try {
        const result = await hook(...hookArguments);

        if (typeof result === 'function') {
          return wrapHook(result as TimedHook, 'cleanup', timeout);
        }

        return result;
      } finally {
        activeHooks.delete(active);
        applyBudget();
      }
    };

    // Vitest stores cleanup timeouts and stack traces on the registered fixture-aware hook.
    return Object.assign(wrapped, hook);
  };

  const installHookWrappers = (suite: Readonly<RunnerTestSuite>) => {
    const hooks = TestRunner.getSuiteHooks(suite);

    // Mutate entries in place: Vitest's beforeAll iterator (or parallel map) holds this array.
    // This setup hook installs wrappers synchronously before the iterator visits later entries.
    hooks.beforeAll.forEach((hook, index) => {
      hooks.beforeAll[index] = wrapHook(hook, 'beforeAll', hookTimeout(hook));
    });

    hooks.beforeEach.forEach((hook, index) => {
      hooks.beforeEach[index] = wrapHook(hook, 'beforeEach', hookTimeout(hook));
    });

    for (const task of suite.tasks) {
      if (task.type === 'suite' && task.mode === 'run') {
        installHookWrappers(task);
      }
    }
  };

  // oxlint-disable-next-line no-empty-pattern -- Vitest passes the suite only when the first parameter destructures, even with no properties.
  beforeAll(({}, suite) => {
    Atomics.store(state, 2, 0);
    installHookWrappers(suite);
    applyBudget();
  });

  beforeEach(({ task, onTestFinished }) => {
    runningTests.set(task.id, { name: task.name, timeout: task.timeout });
    applyBudget();

    onTestFinished(() => {
      runningTests.delete(task.id);
      applyBudget();
    });
  });
}
