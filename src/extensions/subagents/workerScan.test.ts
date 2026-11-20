import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { failedResult } from '../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { HcRuntime } from '../../hc/hc.js';
import type { DeadlineWatchdog, DeadlineWatchdogContext } from './deadlineWatchdog.js';
import { registerWorkerScan } from './subagents.js';
import type { WorkerChildRead, WorkerDelivery } from './workerDelivery.js';
import { createWorkerScan } from './workerScan.js';
import { scratchRootFor } from './workerScratch.js';

const manager = 't-manager';

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
    apply: async (context, managerTerminal, children) => {
      await steps.deadline.apply(context, managerTerminal, children);
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
  const folder = join(scratchRoot, 'assignment-a');
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
    [
      'Worker folder sweep failed: Temporary root tau-worker-scratch is redirected. Cleanup refused.',
      'error',
    ],
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
