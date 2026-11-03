import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import type { HcRuntime } from '../../hc/hc.js';
import type { DeadlineWatchdog, DeadlineWatchdogContext } from './deadlineWatchdog.js';
import type { WorkerChildRead, WorkerDelivery } from './workerDelivery.js';
import { createWorkerScan } from './workerScan.js';

const manager = 't-manager';

beforeEach(() => {
  vi.stubEnv('HC_TERMINAL_ID', manager);
});

afterEach(() => {
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
