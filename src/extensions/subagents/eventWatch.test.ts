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

const staleContext = (): EventWatchContext =>
  ({
    sessionManager: { getEntries: () => [] },
    get ui() {
      throw new Error('This extension ctx is stale after session replacement or reload.');
    },
    isIdle: () => true,
    signal: undefined,
  }) as unknown as EventWatchContext;

it('does not throw when a close notifies a stale context', () => {
  const { hcFake, watch } = createWatch();

  watch.start(staleContext());

  expect(() => {
    hcFake.closeSubscription('boom');
  }).not.toThrow();
});

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

it('keeps reconnecting with a capped backoff and reports one lasting failure', async () => {
  const notifications: [string, string | undefined][] = [];
  const { hcFake, scan, watch } = createWatch();

  watch.start(contextOf((message, kind) => notifications.push([message, kind])));

  expect(hcFake.subscribeCalls).toHaveLength(1);

  for (const delay of [5_000, 15_000, 45_000, 45_000, 45_000]) {
    hcFake.closeSubscription('boom');
    await vi.advanceTimersByTimeAsync(delay);
  }

  expect(hcFake.subscribeCalls).toHaveLength(6);

  const lasting = () =>
    notifications.filter(([message]) => message.includes('keeps failing')).length;

  expect(lasting()).toBe(1);

  hcFake.ready();
  await vi.advanceTimersByTimeAsync(0);

  expect(scan.calls.length).toBeGreaterThanOrEqual(1);

  for (const delay of [5_000, 15_000, 45_000, 45_000]) {
    hcFake.closeSubscription('boom');
    await vi.advanceTimersByTimeAsync(delay);
  }

  expect(lasting()).toBe(2);
});

it('stops reconnecting after session shutdown', async () => {
  const { hcFake, watch } = createWatch();

  watch.start(contextOf(() => undefined));
  watch.stop();

  hcFake.closeSubscription('boom');
  await vi.advanceTimersByTimeAsync(1_000_000);

  expect(hcFake.subscribeCalls).toHaveLength(1);
});
