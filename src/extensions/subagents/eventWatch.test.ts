import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import { createEventWatch } from './eventWatch.js';
import type { EventWatchContext } from './eventWatch.js';
import type { WorkerScan, WorkerScanContext } from './workerScan.js';

const manager = 't-manager';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.stubEnv('HC_TERMINAL_ID', manager);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const createScan = () => {
  const calls: WorkerScanContext[] = [];

  const scan: WorkerScan = {
    scan: (context) => {
      calls.push(context);

      return Promise.resolve();
    },
    clear: () => undefined,
  };

  return { scan, calls };
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
    get ui(): never {
      throw new Error('This extension ctx is stale after session replacement or reload.');
    },
    isIdle: () => true,
    signal: undefined,
  }) as unknown as EventWatchContext;

it('subscribes to the manager terminal children', () => {
  const { hcFake, watch } = createWatch();

  watch.start(contextOf(() => undefined));

  expect(hcFake.subscribeCalls).toEqual([{ childrenOf: manager }]);
});

it('does nothing without a manager terminal', () => {
  vi.stubEnv('HC_TERMINAL_ID', '');

  const { hcFake, scan, watch } = createWatch();

  watch.start(contextOf(() => undefined));

  expect(hcFake.subscribeCalls).toEqual([]);
  expect(scan.calls).toEqual([]);
});

it('releases the live subscription on stop', () => {
  const { hcFake, watch } = createWatch();

  watch.start(contextOf(() => undefined));

  expect(hcFake.liveSubscriptions()).toBe(1);

  watch.stop();

  expect(hcFake.liveSubscriptions()).toBe(0);
});

it('scans for a worker event and ignores a heartbeat', async () => {
  const { hcFake, scan, watch } = createWatch();

  watch.start(contextOf(() => undefined));

  hcFake.emitEvent({ method: 'heartbeat' });
  await vi.advanceTimersByTimeAsync(0);

  expect(scan.calls).toHaveLength(0);

  hcFake.emitEvent({ method: 'event', type: 'labels' });
  await vi.advanceTimersByTimeAsync(0);

  expect(scan.calls).toHaveLength(1);
});

it('reports a close as a worker error notice', () => {
  const notifications: [string, string | undefined][] = [];
  const { hcFake, watch } = createWatch();

  watch.start(contextOf((message, kind) => notifications.push([message, kind])));

  hcFake.closeSubscription('boom');

  const closed = notifications.filter(([message]) => message.includes('subscription closed'));

  expect(closed).toHaveLength(1);
  expect(closed[0]?.[1]).toBe('error');
});

it('reports a close for a replacement context during one outage', () => {
  const first: string[] = [];
  const replacement: string[] = [];
  const { hcFake, watch } = createWatch();

  watch.start(contextOf((message) => first.push(message)));
  hcFake.closeSubscription('first binding');

  watch.start(contextOf((message) => replacement.push(message)));
  hcFake.closeSubscription('replacement binding');

  expect(first.filter((message) => message.includes('subscription closed'))).toHaveLength(1);
  expect(replacement.filter((message) => message.includes('subscription closed'))).toHaveLength(1);
});

it('does not throw when a close notifies a stale context', () => {
  const { hcFake, watch } = createWatch();

  watch.start(staleContext());

  expect(() => {
    hcFake.closeSubscription('boom');
  }).not.toThrow();
});
