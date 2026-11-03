import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import { createEventWatch } from './eventWatch.js';
import type { EventWatchContext } from './eventWatch.js';
import type { WorkerScan, WorkerScanContext } from './workerScan.js';

const manager = 't-manager';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubEnv('HC_TERMINAL_ID', manager);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const createScan = () => {
  const calls: WorkerScanContext[] = [];
  let gate: Promise<void> | undefined;

  const scan: WorkerScan = {
    scan: (context) => {
      calls.push(context);

      return gate ?? Promise.resolve();
    },
    clear: () => undefined,
  };

  return {
    scan,
    calls,
    block: () => {
      const { promise, resolve } = Promise.withResolvers<undefined>();

      gate = promise.then(() => undefined);

      return () => {
        resolve(undefined);
      };
    },
  };
};

const createWatch = () => {
  const hcFake = createHcFake();
  const scan = createScan();
  const watch = createEventWatch(hcFake.subscribe, scan.scan);

  return { hcFake, scan, watch };
};

const contextOf = (
  notify: (message: string, kind: string | undefined) => void,
): EventWatchContext =>
  ({
    sessionManager: { getEntries: () => [] },
    ui: { notify },
    isIdle: () => true,
    signal: undefined,
  }) as unknown as EventWatchContext;

it('starts a scan for a labels event and ignores a heartbeat', async () => {
  const { hcFake, scan, watch } = createWatch();

  watch.start(contextOf(() => undefined));

  hcFake.emitEvent({ method: 'heartbeat' });
  hcFake.emitEvent({ method: 'event', type: 'labels' });
  hcFake.emitEvent({ method: 'event', type: 'status' });

  await vi.advanceTimersByTimeAsync(0);

  expect(scan.calls).toHaveLength(1);
});

it('starts a scan for a finished event and a missed snapshot', async () => {
  const { hcFake, scan, watch } = createWatch();

  watch.start(contextOf(() => undefined));

  hcFake.emitEvent({ method: 'event', type: 'finished' });
  hcFake.emitEvent({ method: 'missed' });

  await vi.advanceTimersByTimeAsync(0);

  expect(scan.calls).toHaveLength(2);
});

it('queues one pending scan for a burst while a scan is running', async () => {
  const { hcFake, scan, watch } = createWatch();
  const release = scan.block();

  watch.start(contextOf(() => undefined));

  hcFake.emitEvent({ method: 'event', type: 'labels' });
  hcFake.emitEvent({ method: 'event', type: 'labels' });
  hcFake.emitEvent({ method: 'event', type: 'labels' });

  expect(scan.calls).toHaveLength(1);

  release();

  await vi.advanceTimersByTimeAsync(0);

  expect(scan.calls).toHaveLength(2);
});

it('starts a scan when the subscription is ready', async () => {
  const { hcFake, scan, watch } = createWatch();

  watch.start(contextOf(() => undefined));
  hcFake.ready();

  await vi.advanceTimersByTimeAsync(0);

  expect(scan.calls).toHaveLength(1);
});

it('does nothing without a manager terminal', () => {
  vi.stubEnv('HC_TERMINAL_ID', '');

  const { hcFake, scan, watch } = createWatch();

  watch.start(contextOf(() => undefined));

  expect(hcFake.subscribeCalls).toEqual([]);
  expect(scan.calls).toEqual([]);
});

it('reconnects with bounded backoff and stops after the schedule', async () => {
  const notifications: [string, string | undefined][] = [];
  const { hcFake, watch } = createWatch();

  watch.start(contextOf((message, kind) => notifications.push([message, kind])));

  expect(hcFake.subscribeCalls).toHaveLength(1);

  hcFake.closeSubscription('boom');
  await vi.advanceTimersByTimeAsync(5_000);

  expect(hcFake.subscribeCalls).toHaveLength(2);

  hcFake.closeSubscription('boom');
  await vi.advanceTimersByTimeAsync(15_000);

  expect(hcFake.subscribeCalls).toHaveLength(3);

  hcFake.closeSubscription('boom');
  await vi.advanceTimersByTimeAsync(45_000);

  expect(hcFake.subscribeCalls).toHaveLength(4);

  hcFake.closeSubscription('boom');
  await vi.advanceTimersByTimeAsync(1_000_000);

  expect(hcFake.subscribeCalls).toHaveLength(4);
  expect(notifications.at(-1)?.[0]).toContain('stopped after repeated failures');
});

it('stops reconnecting after session shutdown', async () => {
  const { hcFake, watch } = createWatch();

  watch.start(contextOf(() => undefined));
  watch.stop();

  hcFake.closeSubscription('boom');
  await vi.advanceTimersByTimeAsync(1_000_000);

  expect(hcFake.subscribeCalls).toHaveLength(1);
});
