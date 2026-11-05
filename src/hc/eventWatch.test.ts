import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createHcFake } from '../../tests/hcFake.js';
import { createEventWatch } from './eventWatch.js';

const terminal = 't-manager';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const createScan = () => {
  const calls: number[] = [];
  let gate: Promise<void> | undefined;

  const scan = () => {
    calls.push(calls.length);

    return gate ?? Promise.resolve();
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
  const notifications: { message: string; key: string }[] = [];

  const watch = createEventWatch({
    subscribe: hcFake.subscribe,
    selector: () => ({ childrenOf: terminal }),
    scan: scan.scan,
    isRelevant: (event) => event.method === 'event' && event.type === 'labels',
    notify: (message, key) => notifications.push({ message, key }),
  });

  return { hcFake, scan, watch, notifications };
};

it('starts a scan when the subscription is ready', async () => {
  const { hcFake, scan, watch } = createWatch();

  watch.start();
  hcFake.ready();
  await vi.advanceTimersByTimeAsync(0);

  expect(scan.calls).toHaveLength(1);
});

it('starts a scan for a relevant event and ignores an irrelevant one', async () => {
  const { hcFake, scan, watch } = createWatch();

  watch.start();
  hcFake.emitEvent({ method: 'event', type: 'status' });
  hcFake.emitEvent({ method: 'event', type: 'labels' });
  await vi.advanceTimersByTimeAsync(0);

  expect(scan.calls).toHaveLength(1);
});

it('queues one pending scan for a burst while a scan is running', async () => {
  const { hcFake, scan, watch } = createWatch();
  const release = scan.block();

  watch.start();
  hcFake.emitEvent({ method: 'event', type: 'labels' });
  hcFake.emitEvent({ method: 'event', type: 'labels' });
  hcFake.emitEvent({ method: 'event', type: 'labels' });

  expect(scan.calls).toHaveLength(1);

  release();
  await vi.advanceTimersByTimeAsync(0);

  expect(scan.calls).toHaveLength(2);
});

it('reconnects on the shared retry delays', async () => {
  const { hcFake, watch } = createWatch();

  watch.start();

  expect(hcFake.subscribeCalls).toHaveLength(1);

  for (const delay of [5_000, 15_000, 45_000, 45_000]) {
    hcFake.closeSubscription('boom');
    await vi.advanceTimersByTimeAsync(delay);
  }

  expect(hcFake.subscribeCalls).toHaveLength(5);
});

it('replaces the live subscription when start is called twice', () => {
  const { hcFake, watch } = createWatch();

  watch.start();
  watch.start();

  expect(hcFake.subscribeCalls).toHaveLength(2);
  expect(hcFake.liveSubscriptions()).toBe(1);

  watch.stop();

  expect(hcFake.liveSubscriptions()).toBe(0);
});

it('clears a pending retry when start is called twice', () => {
  const { hcFake, watch } = createWatch();

  watch.start();
  hcFake.closeSubscription('boom');

  expect(vi.getTimerCount()).toBe(1);

  watch.start();

  expect(vi.getTimerCount()).toBe(0);
  expect(hcFake.subscribeCalls).toHaveLength(2);
  expect(hcFake.liveSubscriptions()).toBe(1);
});

it('ignores a late close from a replaced subscription', () => {
  const { hcFake, watch, notifications } = createWatch();

  watch.start();
  watch.start();

  hcFake.closeSubscriptionAt(0, 'late');

  expect(notifications).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not send a lasting notice before the fourth failure', async () => {
  const { hcFake, watch, notifications } = createWatch();

  const lasting = () =>
    notifications.filter((notification) => notification.key.startsWith('lasting:')).length;

  watch.start();

  for (const delay of [5_000, 15_000, 45_000]) {
    hcFake.closeSubscription('boom');
    await vi.advanceTimersByTimeAsync(delay);

    expect(lasting()).toBe(0);
  }

  hcFake.closeSubscription('boom');
  await vi.advanceTimersByTimeAsync(45_000);

  expect(lasting()).toBe(1);
});

it('shows one close and one lasting notice per outage', async () => {
  const { hcFake, watch, notifications } = createWatch();

  watch.start();

  for (const delay of [5_000, 15_000, 45_000, 45_000, 45_000]) {
    hcFake.closeSubscription('boom');
    await vi.advanceTimersByTimeAsync(delay);
  }

  const closed = () =>
    notifications.filter((notification) => notification.key.startsWith('closed:')).length;

  const lasting = () =>
    notifications.filter((notification) => notification.key.startsWith('lasting:')).length;

  expect(closed()).toBe(1);
  expect(lasting()).toBe(1);

  hcFake.ready();
  await vi.advanceTimersByTimeAsync(0);

  for (const delay of [5_000, 15_000, 45_000, 45_000]) {
    hcFake.closeSubscription('boom');
    await vi.advanceTimersByTimeAsync(delay);
  }

  expect(closed()).toBe(2);
  expect(lasting()).toBe(2);
});

it('stops reconnecting after stop', async () => {
  const { hcFake, watch, notifications } = createWatch();

  watch.start();
  watch.stop();

  hcFake.closeSubscription('boom');
  await vi.advanceTimersByTimeAsync(1_000_000);

  expect(hcFake.subscribeCalls).toHaveLength(1);
  expect(notifications).toEqual([]);
});

it('ignores a late callback after stop', async () => {
  const { hcFake, scan, watch, notifications } = createWatch();

  watch.start();
  watch.stop();

  hcFake.closeSubscriptionAt(0, 'late');
  await vi.advanceTimersByTimeAsync(1_000_000);

  expect(scan.calls).toEqual([]);
  expect(notifications).toEqual([]);
  expect(hcFake.subscribeCalls).toHaveLength(1);
});
