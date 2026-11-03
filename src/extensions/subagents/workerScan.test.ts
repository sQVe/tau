import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { failedResult } from '../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcRuntime } from '../../hc/hc.js';
import type { DeadlineWatchdog, DeadlineWatchdogContext } from './deadlineWatchdog.js';
import { registerWorkerScan } from './subagents.js';
import type { WorkerChildRead, WorkerDelivery } from './workerDelivery.js';
import { createWorkerScan } from './workerScan.js';

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

  await createWorkerScan(hc, steps.delivery, steps.deadline).scan(steps.context);

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

  await createWorkerScan(hc, failingDelivery, steps.deadline).scan(steps.context);

  expect(steps.deadlines).toHaveLength(1);
  expect(steps.notifications).toEqual([['Worker delivery failed: boom', 'error']]);
});

it('reports an hc ls failure through both notices and runs neither step', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();

  hcFake.fail('ls', 'boom', 1);

  await createWorkerScan(hc, steps.delivery, steps.deadline).scan(steps.context);

  expect(steps.order).toEqual([]);

  expect(steps.notifications).toEqual([
    ['Worker delivery failed: hc ls failed: boom', 'error'],
    ['Deadline scan failed: hc ls failed: boom', 'error'],
  ]);
});

it('reads the children once for each scan', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const scanner = createWorkerScan(hc, steps.delivery, steps.deadline);

  await scanner.scan(steps.context);
  await scanner.scan(steps.context);

  expect(hcFake.calls.filter((call) => call.commandArguments[0] === 'ls')).toHaveLength(2);
  expect(steps.order).toEqual(['deliver', 'deadline', 'deliver', 'deadline']);
});

it('does nothing without a manager terminal', async () => {
  vi.stubEnv('HC_TERMINAL_ID', '');

  const { hcFake, hc } = hcFor();
  const steps = createSteps();

  await createWorkerScan(hc, steps.delivery, steps.deadline).scan(steps.context);

  expect(hcFake.calls).toEqual([]);
  expect(steps.order).toEqual([]);
  expect(steps.notifications).toEqual([]);
});

it('retries a failed discovery scan and arms timers when it recovers', async () => {
  const { hcFake, hc } = hcFor();
  const steps = createSteps();
  const realExec = hcFake.exec;
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

  await createWorkerScan(hc, steps.delivery, steps.deadline).scan(steps.context);

  expect(steps.order).toEqual([]);

  await vi.advanceTimersByTimeAsync(5_000);

  expect(listAttempts).toBe(2);
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

  await createWorkerScan(hc, steps.delivery, steps.deadline).scan(steps.context);

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

  const scanner = createWorkerScan(hc, steps.delivery, steps.deadline);

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

  const scanner = createWorkerScan(hc, steps.delivery, steps.deadline);

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

  const scanner = createWorkerScan(hc, steps.delivery, steps.deadline);

  registerWorkerScan(fake.pi, scanner, { start: () => undefined, stop: () => undefined });

  await scanner.scan(steps.context);

  expect(listAttempts).toBe(1);

  for (const handler of fake.handlers.get('session_shutdown') ?? []) {
    await handler({ reason: 'quit' } as never, steps.context as never);
  }

  await vi.advanceTimersByTimeAsync(5_000);

  expect(listAttempts).toBe(1);
});
