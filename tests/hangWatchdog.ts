import { url } from 'node:inspector';
import { setInterval } from 'node:timers';
import { Worker } from 'node:worker_threads';

import type { RunnerTestSuite } from 'vitest';
import { afterAll, beforeAll, beforeEach, expect, TestRunner } from 'vitest';

import { watchdogSource } from './hangWatchdogSource.js';

interface WorkerState {
  config: {
    testTimeout: number;
    hookTimeout: number;
    sequence?: { hooks?: 'stack' | 'list' | 'parallel' };
  };
}

type SuiteHook = 'beforeAll' | 'beforeEach';

// Vitest fails async hangs through its own timeouts. It cannot stop a blocked event loop or a file
// whose collection never finishes, so a watchdog thread kills the worker in those two cases.
// The heartbeat uses the real timer from node:timers because tests may fake the global one, and
// only the watchdog thread reads the clock.
const defaultCollectionMilliseconds = 30_000;
const slackMilliseconds = 1000;
const heartbeatMilliseconds = 100;
const maxMilliseconds = 2 ** 31 - 1;

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

const hooksSequence = () => readConfig().sequence?.hooks ?? 'stack';

const hookTimeoutKey: unique symbol = Symbol.for('VITEST_CLEANUP_TIMEOUT');

type TimedHook = ((...args: never[]) => unknown) & Partial<Record<typeof hookTimeoutKey, unknown>>;

const hookTimeout = (hook: TimedHook) => {
  const timeout = hook[hookTimeoutKey];

  return typeof timeout === 'number' ? timeout : readConfig().hookTimeout;
};

const registeredHookTimeouts = (suite: Readonly<RunnerTestSuite>, name: SuiteHook) =>
  TestRunner.getSuiteHooks(suite)[name].map(hookTimeout);

const ancestorSuites = (suite: Readonly<RunnerTestSuite>) => {
  const suites: Readonly<RunnerTestSuite>[] = [];
  let current = suite;

  while (current.file !== current) {
    suites.push(current);
    current = current.suite ?? current.file;
  }

  suites.push(current);

  return suites;
};

const beforeEachTimeouts = (suite: Readonly<RunnerTestSuite>) =>
  ancestorSuites(suite).flatMap((current) => registeredHookTimeouts(current, 'beforeEach'));

const activeBeforeAll = new Map<Readonly<RunnerTestSuite>, number[]>();
const runningTests = new Map<string, { name: string; timeouts: number[] }>();

const blockingBudget = () => {
  const activeTimeouts = [...activeBeforeAll.values()].flat();
  const testTimeouts = [...runningTests.values()].flatMap((test) => test.timeouts);

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

  const applyRunning = () => {
    Atomics.store(state, 1, blockingBudget());

    const names = [...runningTests.values()].map((test) => test.name).join(', ');

    setLabel(`${testPath()} > ${names}`);
    beat();
  };

  const applyBeforeAll = () => {
    Atomics.store(state, 1, blockingBudget());
    setLabel(`${testPath()} (beforeAll hooks)`);
    beat();
  };

  const applyCleanup = () => {
    Atomics.store(state, 1, blockingBudget());
    setLabel(`${testPath()} (cleanup)`);
    beat();
  };

  const endBeforeAll = (suite: Readonly<RunnerTestSuite>) => {
    for (const current of ancestorSuites(suite)) {
      activeBeforeAll.delete(current);
    }
  };

  const startBeforeAll = (suite: Readonly<RunnerTestSuite>) => {
    endBeforeAll(suite);
    activeBeforeAll.set(suite, registeredHookTimeouts(suite, 'beforeAll'));
    applyBeforeAll();
  };

  const afterAllMarker = (suite: Readonly<RunnerTestSuite>) => {
    endBeforeAll(suite);

    if (runningTests.size > 0) {
      applyRunning();

      return;
    }

    applyCleanup();
  };

  const installAfterAllMarker = (suite: Readonly<RunnerTestSuite>) => {
    const hooks = TestRunner.getSuiteHooks(suite).afterAll;

    if (hooksSequence() === 'stack') {
      hooks.push(afterAllMarker);
    } else {
      hooks.unshift(afterAllMarker);
    }
  };

  const installPhaseMarkers = (suite: Readonly<RunnerTestSuite>) => {
    installAfterAllMarker(suite);

    const pending = [...suite.tasks];

    while (pending.length > 0) {
      const task = pending.pop();

      if (task?.type !== 'suite' || task.mode !== 'run') {
        continue;
      }

      const hooks = TestRunner.getSuiteHooks(task);

      hooks.beforeAll.unshift((markerSuite) => {
        startBeforeAll(markerSuite);
      });

      installAfterAllMarker(task);
      pending.push(...task.tasks);
    }
  };

  // oxlint-disable-next-line no-empty-pattern -- Vitest passes the suite only when the first parameter destructures, even with no properties.
  beforeAll(({}, suite) => {
    Atomics.store(state, 2, 0);
    installPhaseMarkers(suite);
    startBeforeAll(suite);
  });

  beforeEach((context) => {
    const { task } = context;
    const suite = task.suite ?? task.file;

    endBeforeAll(suite);

    const timeouts = [task.timeout, ...beforeEachTimeouts(suite)];

    runningTests.set(task.id, { name: task.name, timeouts });
    applyRunning();

    context.onTestFinished(() => {
      runningTests.delete(task.id);

      if (runningTests.size > 0) {
        applyRunning();

        return;
      }

      applyCleanup();
    });
  });

  afterAll(() => {
    setLabel(`${testPath()} (afterAll hooks and cleanup)`);
  });
}
