import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { failedResult } from '../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { signalActiveGenerationRead } from '../../../tests/sweepLockRead.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { holdFileLock } from '../../fileLock/fileLock.js';
import type { HcRuntime } from '../../hc/hc.js';
import { createDeadlineWatchdog } from './deadlineWatchdog.js';
import type { DeadlineWatchdog, DeadlineWatchdogContext } from './deadlineWatchdog.js';
import { registerWorkerScan } from './subagents.js';
import type { WorkerChildRead, WorkerDelivery } from './workerDelivery.js';
import { sweepLockPath } from './workerFolderSweep.js';
import { assignmentShortId } from './workerName.js';
import { createWorkerScan } from './workerScan.js';
import type { WorkerScanContext } from './workerScan.js';
import { scratchRootFor } from './workerScratch.js';

const manager = 't-manager';

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();
  const readFile = vi.fn<typeof actual.readFile>(actual.readFile);

  return { ...actual, readFile: readFile as typeof actual.readFile };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.setSystemTime(1_000_000);
  vi.stubEnv('HC_TERMINAL_ID', manager);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const scanFor = (hc: HcRuntime, delivery: WorkerDelivery, deadline: DeadlineWatchdog) =>
  createWorkerScan(hc, delivery, deadline, temporaryDirectory(onTestFinished, 'tau-scan-'));

const childRow = { address: 't-child', state: 'live', parent: manager };

const createSteps = () => {
  const order: string[] = [];
  const notifications: [string, string | undefined][] = [];
  const delivered: WorkerChildRead[][] = [];
  const deadlines: WorkerChildRead[][] = [];

  const delivery: WorkerDelivery = {
    deliver: (_context, children) => {
      order.push('deliver');
      delivered.push([...children]);
    },
    showEnded: () => undefined,
    markDeadlinePending: () => undefined,
    clearDeadlinePending: () => undefined,
  };

  const deadline: DeadlineWatchdog = {
    apply: (_context, _managerTerminal, children) => {
      order.push('deadline');
      deadlines.push([...children]);

      return Promise.resolve();
    },
    clear: () => undefined,
  };

  const context = {
    sessionManager: { getEntries: () => [] },
    ui: {
      notify: (message: string, kind: string | undefined) => {
        notifications.push([message, kind]);
      },
    },
  } as unknown as DeadlineWatchdogContext;

  return { order, notifications, delivered, deadlines, delivery, deadline, context };
};

const hcFor = () => {
  const hcFake = createHcFake();

  hcFake.reply('ls', JSON.stringify({ terminals: [childRow] }));
  hcFake.reply('get', JSON.stringify(childRow));

  const hc: HcRuntime = { exec: hcFake.exec, connect: hcFake.connect, cwd: process.cwd() };

  return { hcFake, hc };
};

const deferred = () => {
  let resolvePromise!: () => void;

  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
};

const abortError = (): Error =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

const holdUntilAborted = (entered: () => void, signal: AbortSignal | undefined): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal === undefined || signal.aborted) {
      entered();
      reject(abortError());

      return;
    }

    signal.addEventListener(
      'abort',
      () => {
        reject(abortError());
      },
      { once: true },
    );

    entered();
  });

it('rejects a held call at once without a usable signal', async () => {
  const entered = vi.fn<() => void>();
  const controller = new AbortController();

  controller.abort();

  await expect(holdUntilAborted(entered, undefined)).rejects.toThrow('aborted');
  await expect(holdUntilAborted(entered, controller.signal)).rejects.toThrow('aborted');

  expect(entered).toHaveBeenCalledTimes(2);
});

it('delivers the children before the deadline step runs on the same read', async () => {
  const { hc } = hcFor();
  const steps = createSteps();

  await scanFor(hc, steps.delivery, steps.deadline).scan(steps.context);

  expect(steps.order).toEqual(['deliver', 'deadline']);
  expect(steps.delivered).toEqual(steps.deadlines);
  expect(steps.deadlines[0]?.map((child) => child.terminal.address)).toEqual(['t-child']);
});

it('runs the deadline step when delivery fails', async () => {
  const { hc } = hcFor();
  const steps = createSteps();

  const failingDelivery: WorkerDelivery = {
    ...steps.delivery,
    deliver: () => {
      throw new Error('boom');
    },
  };

  await scanFor(hc, failingDelivery, steps.deadline).scan(steps.context);

  expect(steps.deadlines).toHaveLength(1);
  expect(steps.notifications).toEqual([['Worker delivery failed: boom', 'error']]);
});

it('reports a deadline failure and still sweeps', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();

  const failingDeadline: DeadlineWatchdog = {
    ...steps.deadline,
    apply: () => Promise.reject(new Error('boom')),
  };

  await scanFor(hc, steps.delivery, failingDeadline).scan(steps.context);

  expect(steps.order).toEqual(['deliver']);
  expect(steps.notifications).toHaveLength(1);
  expect(steps.notifications[0]?.[0]).toContain('boom');
  expect(steps.notifications[0]?.[1]).toBe('error');
  expect(hcFake.calls.filter((call) => call.commandArguments[0] === 'ls')).toHaveLength(2);
});

it('reports nothing when the deadline step fails after clear', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();

  const scanner = scanFor(hc, steps.delivery, {
    apply: () => {
      scanner.clear();

      return Promise.reject(new Error('boom'));
    },
    clear: () => undefined,
  });

  await scanner.scan(steps.context);

  expect(steps.order).toEqual(['deliver']);
  expect(steps.notifications).toEqual([]);
  expect(hcFake.calls.filter((call) => call.commandArguments[0] === 'ls')).toHaveLength(1);
});

it('reports an hc ls failure through both notices and runs neither step', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();

  hcFake.fail('ls', 'boom', 1);

  await scanFor(hc, steps.delivery, steps.deadline).scan(steps.context);

  expect(steps.order).toEqual([]);

  expect(steps.notifications).toEqual([
    ['Worker delivery failed: hc ls failed: boom', 'error'],
    ['Deadline scan failed: hc ls failed: boom', 'error'],
  ]);
});

it('reads the children once for each scan', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const scanner = scanFor(hc, steps.delivery, steps.deadline);

  await scanner.scan(steps.context);
  await scanner.scan(steps.context);

  expect(hcFake.calls.filter((call) => call.commandArguments[0] === 'ls')).toHaveLength(4);
  expect(steps.order).toEqual(['deliver', 'deadline', 'deliver', 'deadline']);
});

it('drains only after a second queued scan finishes its sweep', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  const entered = deferred();
  const releaseRead = deferred();
  const sweepEntered = deferred();
  const releaseSweep = deferred();
  const held: string[] = [];
  let listCalls = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] !== 'ls') {
      return realExec(command, commandArguments, options);
    }

    listCalls += 1;

    if (listCalls === 1) {
      held.push(commandArguments[0]);
      entered.resolve();

      await releaseRead.promise;
    }

    if (listCalls === 4) {
      held.push(commandArguments[0]);
      sweepEntered.resolve();

      await releaseSweep.promise;
    }

    return realExec(command, commandArguments, options);
  };

  const scanner = scanFor(hc, steps.delivery, steps.deadline);

  const firstScan = scanner.scan(steps.context);

  await entered.promise;

  const secondScan = scanner.scan(steps.context);

  let drained = false;

  const draining = scanner.drain();

  const settled = draining.then(() => {
    drained = true;

    return undefined;
  });

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(drained).toBe(false);

  releaseRead.resolve();
  await firstScan;
  await sweepEntered.promise;

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(drained).toBe(false);

  releaseSweep.resolve();
  await settled;
  await secondScan;

  expect(drained).toBe(true);
  expect(held).toEqual(['ls', 'ls']);
  expect(steps.order).toEqual(['deliver', 'deadline', 'deliver', 'deadline']);
});

it('stops a child read that never settles when the scan is cleared', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  const entered = deferred();
  let heldSignal: AbortSignal | undefined;

  hc.exec = (command, commandArguments, options) => {
    if (commandArguments[0] !== 'ls') {
      return realExec(command, commandArguments, options);
    }

    heldSignal = options?.signal;

    return holdUntilAborted(entered.resolve, options?.signal);
  };

  const scanner = scanFor(hc, steps.delivery, steps.deadline);

  const scanning = scanner.scan(steps.context);

  await entered.promise;

  scanner.clear();

  expect(heldSignal?.aborted).toBe(true);

  await scanner.drain();
  await scanning;

  expect(steps.order).toEqual([]);
  expect(steps.notifications).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('skips a scan queued before clear', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  const entered = deferred();
  let listCalls = 0;

  hc.exec = (command, commandArguments, options) => {
    if (commandArguments[0] !== 'ls') {
      return realExec(command, commandArguments, options);
    }

    listCalls += 1;

    if (listCalls > 1) {
      return realExec(command, commandArguments, options);
    }

    return holdUntilAborted(entered.resolve, options?.signal);
  };

  const scanner = scanFor(hc, steps.delivery, steps.deadline);

  const firstScan = scanner.scan(steps.context);

  await entered.promise;

  const queuedScan = scanner.scan(steps.context);

  scanner.clear();

  await scanner.drain();
  await firstScan;
  await queuedScan;

  expect(listCalls).toBe(1);
  expect(steps.order).toEqual([]);
  expect(steps.notifications).toEqual([]);
});

it('runs a scan queued while the cancelled run settles', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  const entered = deferred();
  const release = deferred();
  let listCalls = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] !== 'ls') {
      return realExec(command, commandArguments, options);
    }

    listCalls += 1;

    if (listCalls === 1) {
      entered.resolve();

      await release.promise;
    }

    return realExec(command, commandArguments, options);
  };

  const scanner = scanFor(hc, steps.delivery, steps.deadline);

  const cancelled = scanner.scan(steps.context);

  await entered.promise;

  scanner.clear();

  const queued = scanner.scan(steps.context);

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(listCalls).toBe(1);
  expect(steps.order).toEqual([]);

  release.resolve();
  await cancelled;
  await queued;

  expect(steps.order).toEqual(['deliver', 'deadline']);
});

it('reports nothing when a child read is cancelled at clear', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  const entered = deferred();

  hc.exec = (command, commandArguments, options) => {
    if (commandArguments[0] !== 'get') {
      return realExec(command, commandArguments, options);
    }

    return holdUntilAborted(entered.resolve, options?.signal);
  };

  const scanner = scanFor(hc, steps.delivery, steps.deadline);

  const scanning = scanner.scan(steps.context);

  await entered.promise;

  scanner.clear();

  await scanner.drain();
  await scanning;

  expect(steps.order).toEqual([]);
  expect(steps.notifications).toEqual([]);
});

it('reports nothing when a sweep read is cancelled at clear', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  const entered = deferred();
  let listCalls = 0;

  hc.exec = (command, commandArguments, options) => {
    if (commandArguments[0] !== 'ls') {
      return realExec(command, commandArguments, options);
    }

    listCalls += 1;

    if (listCalls !== 2) {
      return realExec(command, commandArguments, options);
    }

    return holdUntilAborted(entered.resolve, options?.signal);
  };

  const scanner = scanFor(hc, steps.delivery, steps.deadline);

  const scanning = scanner.scan(steps.context);

  await entered.promise;

  scanner.clear();

  await scanner.drain();
  await scanning;

  expect(steps.order).toEqual(['deliver', 'deadline']);
  expect(steps.notifications).toEqual([]);
});

it('stops a deadline action read that never settles when the scan is cleared', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-scan-');
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  const entered = deferred();
  const assignmentPath = '/agent/missing.json';
  let getCalls = 0;
  let heldSignal: AbortSignal | undefined;

  hcFake.reply(
    'get',
    JSON.stringify({
      address: 't-child',
      state: 'live',
      parent: manager,
      labels: { 'tau.assignment': assignmentPath },
    }),
  );

  hc.exec = (command, commandArguments, options) => {
    if (commandArguments[0] !== 'get') {
      return realExec(command, commandArguments, options);
    }

    getCalls += 1;

    if (getCalls !== 2) {
      return realExec(command, commandArguments, options);
    }

    heldSignal = options?.signal;

    return holdUntilAborted(entered.resolve, options?.signal);
  };

  const watchdog = createDeadlineWatchdog(hc, steps.delivery);
  const scanner = createWorkerScan(hc, steps.delivery, watchdog, agentDirectory);

  const scanning = scanner.scan(steps.context);

  await entered.promise;

  watchdog.clear();
  scanner.clear();

  expect(heldSignal?.aborted).toBe(true);

  await scanner.drain();
  await scanning;

  expect(steps.order).toEqual(['deliver']);
  expect(steps.notifications).toEqual([[`Missing assignment file: ${assignmentPath}.`, 'error']]);
  expect(vi.getTimerCount()).toBe(0);
});

it('reports no read failure and retries nothing when only the scan clear cancels the deadline read', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-scan-');
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  const entered = deferred();
  const assignmentPath = '/agent/missing.json';
  let getCalls = 0;

  hcFake.reply(
    'get',
    JSON.stringify({
      address: 't-child',
      state: 'live',
      parent: manager,
      labels: { 'tau.assignment': assignmentPath },
    }),
  );

  hc.exec = (command, commandArguments, options) => {
    if (commandArguments[0] !== 'get') {
      return realExec(command, commandArguments, options);
    }

    getCalls += 1;

    if (getCalls !== 2) {
      return realExec(command, commandArguments, options);
    }

    return holdUntilAborted(entered.resolve, options?.signal);
  };

  const watchdog = createDeadlineWatchdog(hc, steps.delivery);
  const scanner = createWorkerScan(hc, steps.delivery, watchdog, agentDirectory);

  const scanning = scanner.scan(steps.context);

  await entered.promise;

  scanner.clear();

  await scanner.drain();
  await scanning;

  expect(steps.order).toEqual(['deliver']);

  expect(steps.notifications).toEqual([[`Missing assignment file: ${assignmentPath}.`, 'error']]);

  expect(vi.getTimerCount()).toBe(0);

  await vi.advanceTimersByTimeAsync(60_000);

  expect(getCalls).toBe(2);
});

it('uses the hc exec in place when a scan runs', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  let listCalls = 0;

  const scanner = scanFor(hc, steps.delivery, steps.deadline);

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'ls') {
      listCalls += 1;
    }

    return realExec(command, commandArguments, options);
  };

  await scanner.scan(steps.context);

  expect(listCalls).toBe(2);
  expect(steps.order).toEqual(['deliver', 'deadline']);
  expect(steps.notifications).toEqual([]);
});

it('runs a scan started after clear on a fresh signal', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  const entered = deferred();
  let heldSignal: AbortSignal | undefined;

  hc.exec = (command, commandArguments, options) => {
    if (commandArguments[0] !== 'ls') {
      return realExec(command, commandArguments, options);
    }

    heldSignal = options?.signal;

    return holdUntilAborted(entered.resolve, options?.signal);
  };

  const scanner = scanFor(hc, steps.delivery, steps.deadline);

  const aborted = scanner.scan(steps.context);

  await entered.promise;

  scanner.clear();

  expect(heldSignal?.aborted).toBe(true);

  await aborted;

  hc.exec = realExec;

  await scanner.scan(steps.context);

  expect(steps.order).toEqual(['deliver', 'deadline']);
  expect(steps.notifications).toEqual([]);
  expect(hcFake.calls.at(-1)?.signal?.aborted).toBe(false);
});

it('does nothing without a manager terminal', async () => {
  vi.stubEnv('HC_TERMINAL_ID', '');

  const { hcFake, hc } = hcFor();
  const steps = createSteps();

  await scanFor(hc, steps.delivery, steps.deadline).scan(steps.context);

  expect(hcFake.calls).toEqual([]);
  expect(steps.order).toEqual([]);
  expect(steps.notifications).toEqual([]);
});

it('retries a failed discovery scan and arms timers when it recovers', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  const recovered = deferred();
  let listAttempts = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'ls') {
      listAttempts += 1;

      if (listAttempts === 1) {
        return failedResult('boom');
      }
    }

    return realExec(command, commandArguments, options);
  };

  const deadline: DeadlineWatchdog = {
    ...steps.deadline,
    apply: async (context, managerTerminal, children, runtime) => {
      await steps.deadline.apply(context, managerTerminal, children, runtime);
      recovered.resolve();
    },
  };

  const scanner = scanFor(hc, steps.delivery, deadline);

  onTestFinished(async () => {
    vi.stubEnv('HC_TERMINAL_ID', '');
    await scanner.scan(steps.context);
  });

  await scanner.scan(steps.context);

  expect(steps.order).toEqual([]);

  await vi.advanceTimersByTimeAsync(5_000);
  await recovered.promise;

  // Queue behind the retry's sweep, so its lock is released before teardown.
  vi.stubEnv('HC_TERMINAL_ID', '');
  await scanner.scan(steps.context);

  expect(listAttempts).toBe(3);
  expect(steps.order).toEqual(['deliver', 'deadline']);
});

it('stops retrying a failed discovery scan after the bounded schedule', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  let listAttempts = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'ls') {
      listAttempts += 1;

      return failedResult('persistent');
    }

    return realExec(command, commandArguments, options);
  };

  await scanFor(hc, steps.delivery, steps.deadline).scan(steps.context);

  await vi.advanceTimersByTimeAsync(5_000 + 15_000 + 45_000);
  await vi.advanceTimersByTimeAsync(1_000_000);

  expect(listAttempts).toBe(4);
});

it('skips a discovery retry queued behind a blocked scan after clear', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  const blocked = deferred();
  const release = deferred();
  let listAttempts = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'ls') {
      listAttempts += 1;

      if (listAttempts === 2) {
        blocked.resolve();

        await release.promise;
      }

      return failedResult('boom');
    }

    return realExec(command, commandArguments, options);
  };

  const scanner = scanFor(hc, steps.delivery, steps.deadline);

  await scanner.scan(steps.context);

  const blocking = scanner.scan(steps.context);

  await blocked.promise;

  await vi.advanceTimersByTimeAsync(5_000);

  scanner.clear();
  release.resolve();

  await blocking;

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(listAttempts).toBe(2);
});

it('schedules no retry after shutdown', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
  let listAttempts = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'ls') {
      listAttempts += 1;

      return failedResult('boom');
    }

    return realExec(command, commandArguments, options);
  };

  const scanner = scanFor(hc, steps.delivery, steps.deadline);

  scanner.clear();

  await scanner.scan(steps.context);
  await vi.advanceTimersByTimeAsync(1_000_000);

  expect(listAttempts).toBe(1);
});

it('cancels a pending discovery retry at session shutdown', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const fake = fakeExtensionApi();
  const realExec = hcFake.exec;
  let listAttempts = 0;

  hc.exec = async (command, commandArguments, options) => {
    if (commandArguments[0] === 'ls') {
      listAttempts += 1;

      return failedResult('persistent');
    }

    return realExec(command, commandArguments, options);
  };

  const scanner = scanFor(hc, steps.delivery, steps.deadline);

  registerWorkerScan(fake.pi, scanner, { start: () => undefined, stop: () => undefined });

  await scanner.scan(steps.context);

  expect(listAttempts).toBe(1);

  for (const handler of fake.handlers.get('session_shutdown') ?? []) {
    await handler({ reason: 'quit' } as never, steps.context as never);
  }

  await vi.advanceTimersByTimeAsync(5_000);

  expect(listAttempts).toBe(1);
});

const sweepSetup = () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-scan-');
  const { hcFake, hc } = hcFor();
  const steps = createSteps();

  return { agentDirectory, hcFake, hc, steps, scratchRoot: scratchRootFor(agentDirectory) };
};

const scratchLabel = (agentDirectory: string, assignmentId: string) => ({
  'tau.assignment': join(
    agentDirectory,
    'tau',
    'checkout',
    'assignments',
    assignmentId,
    'assignment.json',
  ),
});

it('sweeps after a scan', async () => {
  const { agentDirectory, hcFake, hc, steps, scratchRoot } = sweepSetup();
  const folder = join(scratchRoot, assignmentShortId('assignment-a'));
  const labels = scratchLabel(agentDirectory, 'assignment-a');

  mkdirSync(folder, { recursive: true });
  vi.setSystemTime(statSync(folder).birthtimeMs + 120_000);

  const terminalList = (state: string) =>
    JSON.stringify({ terminals: [{ ...childRow, state, labels }] });

  hcFake.reply('ls', terminalList('live'));

  const deadline: DeadlineWatchdog = {
    apply: () => {
      hcFake.reply('ls', terminalList('finished'));

      return Promise.resolve();
    },
    clear: () => undefined,
  };

  await createWorkerScan(hc, steps.delivery, deadline, agentDirectory).scan(steps.context);

  expect(existsSync(folder)).toBe(false);
  expect(steps.notifications).toEqual([]);
});

it('leaves the worker folder untouched when the run is cancelled before the sweep', async () => {
  const { agentDirectory, hcFake, hc, steps, scratchRoot } = sweepSetup();
  const folder = join(scratchRoot, assignmentShortId('assignment-a'));
  const snapshot = join(agentDirectory, 'tmp', 'tau-worker-packages', 'snapshot-a');

  mkdirSync(folder, { recursive: true });
  mkdirSync(snapshot, { recursive: true });
  vi.setSystemTime(statSync(folder).birthtimeMs + 120_000);
  hcFake.reply('ls', JSON.stringify({ terminals: [] }));

  const scanner = createWorkerScan(
    hc,
    steps.delivery,
    {
      apply: () => {
        scanner.clear();

        return Promise.resolve();
      },
      clear: () => undefined,
    },
    agentDirectory,
  );

  await scanner.scan(steps.context);

  expect(existsSync(folder)).toBe(true);
  expect(existsSync(snapshot)).toBe(true);
  expect(existsSync(join(snapshot, '.tau-unused-since'))).toBe(false);
});

it('stops reporting sweep failures once the run is cleared', async () => {
  const { agentDirectory, hcFake, hc, steps } = sweepSetup();

  hcFake.reply(
    'ls',
    JSON.stringify({
      terminals: [
        { address: 't-one', state: 'live' },
        { address: 't-two', state: 'live' },
      ],
    }),
  );

  hcFake.failGet('t-one', 'boom');
  hcFake.failGet('t-two', 'boom');

  const scanner = createWorkerScan(hc, steps.delivery, steps.deadline, agentDirectory);

  const context = {
    ...steps.context,
    ui: {
      notify: (message: string, kind: 'error' | 'info' | 'warning' | undefined) => {
        steps.context.ui.notify(message, kind);
        scanner.clear();
      },
    },
  } as unknown as WorkerScanContext;

  await scanner.scan(context);

  expect(steps.notifications).toEqual([
    [
      'Worker folder sweep failed: Reading terminal t-one failed: hc get t-one failed: boom. Kept its folders.',
      'error',
    ],
  ]);
});

it('stops waiting for the sweep lock when the scan is cleared', async () => {
  const { agentDirectory, hcFake, hc, steps, scratchRoot } = sweepSetup();
  const folder = join(scratchRoot, assignmentShortId('assignment-a'));

  const held = await holdFileLock({
    lockPath: sweepLockPath(agentDirectory),
    checkout: agentDirectory,
    terminal: undefined,
  });

  if (held.kind !== 'held') {
    throw new Error('The sweep lock was not free.');
  }

  onTestFinished(async () => {
    await held.release();
  });

  mkdirSync(folder, { recursive: true });
  vi.setSystemTime(statSync(folder).birthtimeMs + 120_000);
  hcFake.reply('ls', JSON.stringify({ terminals: [] }));

  const lockWait = signalActiveGenerationRead(agentDirectory, 1);

  const scanner = createWorkerScan(
    hc,
    steps.delivery,
    { apply: () => Promise.resolve(), clear: () => undefined },
    agentDirectory,
  );

  const scanning = scanner.scan(steps.context);

  await lockWait;

  let drained = false;

  const settling = scanner.drain().then(() => {
    drained = true;

    return undefined;
  });

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(drained).toBe(false);

  scanner.clear();
  await settling;
  await scanning;

  expect(existsSync(folder)).toBe(true);
  expect(steps.notifications).toEqual([]);
});

it('reports each sweep removal error', async () => {
  const { agentDirectory, hcFake, hc, steps, scratchRoot } = sweepSetup();
  const elsewhere = temporaryDirectory(onTestFinished, 'tau-scan-redirect-');
  const target = join(elsewhere, 'assignment-a');

  mkdirSync(target);
  mkdirSync(dirname(scratchRoot), { recursive: true });
  symlinkSync(elsewhere, scratchRoot);
  vi.setSystemTime(statSync(target).birthtimeMs + 120_000);
  hcFake.reply('ls', JSON.stringify({ terminals: [] }));

  await createWorkerScan(hc, steps.delivery, steps.deadline, agentDirectory).scan(steps.context);

  expect(existsSync(target)).toBe(true);

  expect(steps.notifications).toEqual([
    ['Worker folder sweep failed: Temporary root ws is redirected. Cleanup refused.', 'error'],
  ]);
});

it('reports a sweep that throws and still finishes the scan', async () => {
  const { agentDirectory, hc, steps, scratchRoot } = sweepSetup();

  mkdirSync(dirname(scratchRoot), { recursive: true });
  writeFileSync(scratchRoot, 'not a folder');

  await createWorkerScan(hc, steps.delivery, steps.deadline, agentDirectory).scan(steps.context);

  expect(steps.order).toEqual(['deliver', 'deadline']);
  expect(steps.notifications).toHaveLength(1);
  expect(steps.notifications[0]?.[0]).toMatch(/^Worker folder sweep failed: .*ENOTDIR/);
  expect(steps.notifications[0]?.[1]).toBe('error');
});
