import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import type { EventWatch } from './eventWatch.js';
import { registerWorkerScan } from './subagents.js';
import type { WorkerScan, WorkerScanContext } from './workerScan.js';

const createScan = () => {
  const calls: WorkerScanContext[] = [];

  const scan: WorkerScan = {
    scan: (context) => {
      calls.push(context);

      return Promise.resolve();
    },
    clear: vi.fn<() => void>(),
  };

  return { scan, calls };
};

const createEvents = () => {
  const start = vi.fn<(context: WorkerScanContext) => void>();
  const stop = vi.fn<() => void>();

  return { events: { start, stop } as EventWatch, start, stop };
};

const contextOf = (): ExtensionContext =>
  ({
    sessionManager: { getEntries: () => [] },
    ui: { notify: vi.fn<(message: string, kind: string | undefined) => void>() },
    isIdle: () => true,
    signal: undefined,
  }) as unknown as ExtensionContext;

it('starts the event watch and a scan at session start', () => {
  const fake = fakeExtensionApi();
  const { scan, calls } = createScan();
  const events = createEvents();
  const context = contextOf();

  registerWorkerScan(fake.pi, scan, events.events);
  fake.handler('session_start')({}, context);

  expect(calls).toEqual([context]);
  expect(events.start).toHaveBeenCalledWith(context);
});

it('starts a scan at session compaction', () => {
  const fake = fakeExtensionApi();
  const { scan, calls } = createScan();
  const context = contextOf();

  registerWorkerScan(fake.pi, scan, createEvents().events);
  fake.handler('session_compact')({}, context);

  expect(calls).toEqual([context]);
});

it('clears the scan and stops the event watch at session shutdown', () => {
  const fake = fakeExtensionApi();
  const { scan } = createScan();
  const events = createEvents();

  registerWorkerScan(fake.pi, scan, events.events);
  fake.handler('session_shutdown')({ reason: 'quit' }, contextOf());

  expect(scan.clear).toHaveBeenCalledTimes(1);
  expect(events.stop).toHaveBeenCalledTimes(1);
});

it('registers no input handler for the removed note trigger', () => {
  const fake = fakeExtensionApi();

  registerWorkerScan(fake.pi, createScan().scan, createEvents().events);

  expect(fake.handlers.get('input')).toBeUndefined();
});
