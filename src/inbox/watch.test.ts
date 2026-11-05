import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { createHcFake } from '../../tests/hcFake.js';
import type { Exec } from '../command.js';
import { writeRecord } from '../record.js';
import { ensureTauDirectory } from '../tauDirectory.js';
import type { Wake, WakeMessage } from '../wake/wake.js';
import type { InboxScanContext, StartupGate } from './receive.js';
import {
  leaseCleanupMilliseconds,
  leaseLifetimeMilliseconds,
  leaseRenewalMilliseconds,
} from './session.js';
import { createInboxWatch } from './watch.js';

type ExecResult = Awaited<ReturnType<Exec>>;

interface Hold {
  matches: (commandArguments: readonly string[]) => boolean;
  entered: PromiseWithResolvers<undefined>;
  released: PromiseWithResolvers<undefined>;
  used: boolean;
}

const terminal = 't7';
const sessionId = 'session-1';
const messageId = '11111111-1111-4111-8111-111111111111';
const now = 1_000_000;

const succeeded = (labels: Record<string, string>): ExecResult => ({
  code: 0,
  killed: false,
  truncated: false,
  stdout: JSON.stringify({ address: terminal, state: 'live', labels }),
  stderr: '',
});

const failed: ExecResult = { code: 1, killed: false, truncated: false, stdout: '', stderr: 'down' };
const killed: ExecResult = { code: 1, killed: true, truncated: false, stdout: '', stderr: '' };

const waitForRelease = async (hold: Hold, signal: AbortSignal | undefined): Promise<boolean> => {
  hold.entered.resolve(undefined);

  const aborted = new Promise<boolean>((resolve) => {
    signal?.addEventListener('abort', () => {
      resolve(false);
    });
  });

  return Promise.race([hold.released.promise.then(() => true), aborted]);
};

// A terminal whose labels change with each `hc label` call. A hold keeps one matching call open
// until the test releases it; the label change lands at release.
const createTerminal = () => {
  const labels: Record<string, string> = {};
  const calls: string[][] = [];
  const holds: Hold[] = [];
  const failures: string[] = [];

  const apply = (commandArguments: readonly string[]): void => {
    for (const assignment of commandArguments.slice(4)) {
      const split = assignment.indexOf('=');
      const key = assignment.slice(0, split);
      const value = assignment.slice(split + 1);

      if (value === '') {
        Reflect.deleteProperty(labels, key);
      } else {
        labels[key] = value;
      }
    }
  };

  const exec: Exec = async (_command, commandArguments, options) => {
    calls.push([...commandArguments]);

    const failureIndex = failures.indexOf(commandArguments[0] ?? '');

    if (failureIndex !== -1) {
      failures.splice(failureIndex, 1);

      return failed;
    }

    const hold = holds.find((candidate) => !candidate.used && candidate.matches(commandArguments));

    if (hold !== undefined) {
      hold.used = true;

      const released = await waitForRelease(hold, options?.signal);

      if (!released) {
        return killed;
      }
    }

    if (commandArguments[0] === 'label') {
      apply(commandArguments);
    }

    return succeeded({ ...labels });
  };

  const hold = (matches: (commandArguments: readonly string[]) => boolean) => {
    const entry: Hold = {
      matches,
      entered: Promise.withResolvers<undefined>(),
      released: Promise.withResolvers<undefined>(),
      used: false,
    };

    holds.push(entry);

    return {
      entered: entry.entered.promise,
      release: () => {
        entry.released.resolve(undefined);
      },
    };
  };

  const leaseWrites = (): string[] =>
    calls
      .filter((call) => call[0] === 'label' && call.at(-1)?.startsWith('tau.inbox=') === true)
      .map((call) => call.at(-1)?.slice('tau.inbox='.length) ?? '');

  const getCalls = (): number => calls.filter((call) => call[0] === 'get').length;

  return {
    exec,
    labels,
    calls,
    hold,
    failNext: (command: 'get' | 'label') => failures.push(command),
    leaseWrites,
    getCalls,
  };
};

type Terminal = ReturnType<typeof createTerminal>;

const isLeaseWrite = (commandArguments: readonly string[]): boolean =>
  commandArguments[0] === 'label' && commandArguments.at(-1)?.startsWith('tau.inbox=') === true;

const isGet = (commandArguments: readonly string[]): boolean => commandArguments[0] === 'get';

const leaseOf = (session: string, expiresAt: number): string => `${session}:${expiresAt}`;

const createGate = () => {
  let open = true;
  let waiters: (() => void)[] = [];
  let calls = 0;
  const listeners: { count: number; resolve: () => void }[] = [];

  const gate: StartupGate = {
    whenReady: () => {
      calls += 1;

      for (const listener of listeners.filter((candidate) => calls >= candidate.count)) {
        listener.resolve();
      }

      if (open) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    isReady: () => open,
  };

  // Resolves once a scan has waited on the gate `count` times.
  const reached = (count: number): Promise<void> =>
    new Promise<void>((resolve) => {
      listeners.push({ count, resolve });

      if (calls >= count) {
        resolve();
      }
    });

  return {
    gate,
    reached,
    hold: () => {
      open = false;
    },
    release: () => {
      open = true;

      for (const resolve of waiters) {
        resolve();
      }

      waiters = [];
    },
  };
};

const context = {
  sessionManager: { getEntries: () => [] },
  ui: { notify: () => undefined },
  isIdle: () => true,
  signal: undefined,
} as unknown as InboxScanContext;

const createHarness = () => {
  const fake = createHcFake();
  const terminalState = createTerminal();
  const startup = createGate();
  const messages: WakeMessage[] = [];
  const notices: string[] = [];
  const woken = Promise.withResolvers<undefined>();

  const wake: Wake = (_context, message) => {
    messages.push(message);
    woken.resolve(undefined);
  };

  const watch = createInboxWatch({
    hc: { exec: terminalState.exec, connect: fake.connect, cwd: '/repository' },
    subscribe: fake.subscribe,
    terminal: () => terminal,
    gate: startup.gate,
    wake,
    notify: (_context, message) => notices.push(message),
  });

  return {
    fake,
    terminal: terminalState,
    startup,
    messages,
    notices,
    woken: woken.promise,
    watch,
  };
};

// Lets pending hc replies and the scans they start finish. Timers stay fake.
const settle = async (): Promise<void> => {
  for (let round = 0; round < 10; round += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
};

const queueMessage = async (
  state: Terminal,
  registerCleanup: (cleanup: () => Promise<void>) => void,
): Promise<void> => {
  const root = await createTemporaryRepository(registerCleanup);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = join(directory, `${messageId}.json`);

  await writeRecord(path, {
    version: 1,
    messageId,
    targetTerminal: terminal,
    targetSessionId: sessionId,
    family: 'handover',
    text: 'Handover body\n',
  });

  state.labels[`tau.inbox.${messageId}`] = path;
};

const startReady = async (harness: ReturnType<typeof createHarness>): Promise<void> => {
  await harness.watch.start({ sessionId, context });
  harness.fake.ready();
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });

  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
});

it('sets the lease only after the subscription is ready', async () => {
  const harness = createHarness();

  await harness.watch.start({ sessionId, context });
  harness.watch.requestScan();
  await settle();

  expect(harness.terminal.calls).toEqual([]);
  expect(harness.fake.subscribeCalls).toEqual([{ terminal }]);

  harness.fake.ready();
  await settle();

  expect(harness.terminal.leaseWrites()).toEqual([
    leaseOf(sessionId, now + leaseLifetimeMilliseconds),
  ]);

  await harness.watch.stop();
});

it('writes no lease when the subscription closes before the claim runs', async () => {
  const harness = createHarness();

  await harness.watch.start({ sessionId, context });
  harness.fake.ready();
  harness.fake.closeSubscription('lost');
  await settle();

  expect(harness.terminal.leaseWrites()).toEqual([]);

  await harness.watch.stop();
});

it('renews the lease with a later expiry while ready', async () => {
  const harness = createHarness();

  await startReady(harness);
  await vi.advanceTimersByTimeAsync(leaseRenewalMilliseconds);
  await settle();

  expect(harness.terminal.leaseWrites()).toEqual([
    leaseOf(sessionId, now + leaseLifetimeMilliseconds),
    leaseOf(sessionId, now + leaseRenewalMilliseconds + leaseLifetimeMilliseconds),
  ]);

  // One read for the first scan and one for the renewal; a renewal starts no scan.
  expect(harness.terminal.getCalls()).toBe(2);

  await harness.watch.stop();
});

it('stops renewal when the subscription closes and resumes it after a reconnect', async () => {
  const harness = createHarness();

  await startReady(harness);
  harness.fake.closeSubscription('lost');
  await vi.advanceTimersByTimeAsync(leaseRenewalMilliseconds * 3);
  await settle();

  expect(harness.terminal.leaseWrites()).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(45_000);
  harness.fake.ready();
  await settle();

  expect(harness.terminal.leaseWrites()).toHaveLength(2);

  await vi.advanceTimersByTimeAsync(leaseRenewalMilliseconds);
  await settle();

  expect(harness.terminal.leaseWrites()).toHaveLength(3);

  await harness.watch.stop();
});

it('shows a notice when the subscription closes', async () => {
  const harness = createHarness();

  await startReady(harness);
  harness.fake.closeSubscription('lost');

  expect(harness.notices).toHaveLength(1);

  await harness.watch.stop();
});

it('does not restart renewal when the claim completes after a disconnect', async () => {
  const harness = createHarness();
  const claim = harness.terminal.hold(isLeaseWrite);

  await harness.watch.start({ sessionId, context });
  harness.fake.ready();
  await claim.entered;
  harness.fake.closeSubscription('lost');
  claim.release();
  await settle();
  await vi.advanceTimersByTimeAsync(leaseRenewalMilliseconds * 3);
  await settle();

  expect(harness.terminal.leaseWrites()).toHaveLength(1);

  await harness.watch.stop();
});

it('writes no renewal when its read completes after a disconnect', async () => {
  const harness = createHarness();

  await startReady(harness);

  const read = harness.terminal.hold(isGet);

  await vi.advanceTimersByTimeAsync(leaseRenewalMilliseconds);
  await read.entered;
  harness.fake.closeSubscription('lost');
  read.release();
  await settle();

  expect(harness.terminal.leaseWrites()).toHaveLength(1);

  await harness.watch.stop();
});

it('retries a failed first claim while ready and then delivers', async ({ onTestFinished }) => {
  const harness = createHarness();

  await queueMessage(harness.terminal, onTestFinished);
  harness.terminal.failNext('label');
  await startReady(harness);
  await harness.startup.reached(1);
  await settle();

  expect(harness.terminal.labels['tau.inbox']).toBeUndefined();
  expect(harness.messages).toEqual([]);

  await vi.advanceTimersByTimeAsync(leaseRenewalMilliseconds);
  await harness.woken;

  expect(harness.terminal.labels['tau.inbox']).toMatch(/^session-1:/);
  expect(harness.messages).toHaveLength(1);

  await harness.watch.stop();
});

it('claims on retry after a failed first claim over a crashed session lease', async ({
  onTestFinished,
}) => {
  const harness = createHarness();
  const crashed = leaseOf('crashed-session', now + leaseLifetimeMilliseconds);

  harness.terminal.labels['tau.inbox'] = crashed;
  await queueMessage(harness.terminal, onTestFinished);
  harness.terminal.failNext('label');
  await startReady(harness);
  await harness.startup.reached(1);
  await settle();

  expect(harness.terminal.labels['tau.inbox']).toBe(crashed);
  expect(harness.messages).toEqual([]);

  await vi.advanceTimersByTimeAsync(leaseRenewalMilliseconds);
  await harness.woken;

  expect(harness.terminal.labels['tau.inbox']).toMatch(/^session-1:/);
  expect(harness.messages).toHaveLength(1);

  await harness.watch.stop();
});

it('stays lost and never writes the lease again after another session takes it', async () => {
  const harness = createHarness();

  await startReady(harness);

  harness.terminal.labels['tau.inbox'] = leaseOf('session-2', now + leaseLifetimeMilliseconds * 5);

  await vi.advanceTimersByTimeAsync(leaseRenewalMilliseconds);
  await settle();

  const readsWhenLost = harness.terminal.getCalls();

  await vi.advanceTimersByTimeAsync(leaseRenewalMilliseconds * 3);
  await settle();

  expect(harness.terminal.getCalls()).toBe(readsWhenLost);

  harness.fake.closeSubscription('lost');
  await vi.advanceTimersByTimeAsync(45_000);
  harness.fake.ready();
  await settle();

  const readsAfterReconnect = harness.terminal.getCalls();

  // Only the scan reads after the reconnect; a lost session does no lease work.
  expect(readsAfterReconnect).toBe(readsWhenLost + 1);

  await vi.advanceTimersByTimeAsync(leaseRenewalMilliseconds * 3);
  await settle();

  expect(harness.terminal.getCalls()).toBe(readsAfterReconnect);
  expect(harness.terminal.leaseWrites()).toHaveLength(1);
  expect(harness.terminal.labels['tau.inbox']).toMatch(/^session-2:/);

  await harness.watch.stop();

  expect(harness.terminal.labels['tau.inbox']).toMatch(/^session-2:/);
});

it('does not wake after another session takes the lease during the startup wait', async ({
  onTestFinished,
}) => {
  const harness = createHarness();

  await queueMessage(harness.terminal, onTestFinished);
  harness.startup.hold();
  await harness.watch.start({ sessionId, context });
  harness.fake.ready();
  await harness.startup.reached(1);

  harness.terminal.labels['tau.inbox'] = leaseOf('session-2', now + leaseLifetimeMilliseconds);
  harness.fake.emitEvent({ method: 'event', type: 'labels' });
  harness.startup.release();
  await settle();

  expect(harness.messages).toEqual([]);

  await harness.watch.stop();
});

it('stays lost when a renewal in flight lands after the loss', async ({ onTestFinished }) => {
  const harness = createHarness();

  await queueMessage(harness.terminal, onTestFinished);
  harness.startup.hold();
  await harness.watch.start({ sessionId, context });
  harness.fake.ready();
  await harness.startup.reached(1);

  const renewal = harness.terminal.hold(isLeaseWrite);

  await vi.advanceTimersByTimeAsync(leaseRenewalMilliseconds);
  await renewal.entered;

  harness.terminal.labels['tau.inbox'] = leaseOf('session-2', now + leaseLifetimeMilliseconds * 5);
  harness.startup.release();
  await settle();
  renewal.release();
  await settle();
  harness.fake.emitEvent({ method: 'event', type: 'labels' });
  await harness.startup.reached(2);
  await settle();

  expect(harness.messages).toEqual([]);

  await harness.watch.stop();
});

it('does not wake when the lease read before the wake fails', async ({ onTestFinished }) => {
  const harness = createHarness();

  await queueMessage(harness.terminal, onTestFinished);
  harness.startup.hold();
  await harness.watch.start({ sessionId, context });
  harness.fake.ready();
  await harness.startup.reached(1);
  harness.terminal.failNext('get');
  harness.startup.release();
  await settle();

  expect(harness.messages).toEqual([]);

  await harness.watch.stop();
});

it('delivers a message queued before ready once startup opens', async ({ onTestFinished }) => {
  const harness = createHarness();

  await queueMessage(harness.terminal, onTestFinished);
  harness.startup.hold();
  await harness.watch.start({ sessionId, context });
  harness.fake.ready();
  await harness.startup.reached(1);

  expect(harness.messages).toEqual([]);

  harness.startup.release();
  await harness.woken;

  expect(harness.messages).toHaveLength(1);

  await harness.watch.stop();
});

it('removes its own lease at shutdown', async () => {
  const harness = createHarness();

  await startReady(harness);
  await harness.watch.stop();

  expect(harness.terminal.labels['tau.inbox']).toBeUndefined();
  expect(harness.fake.liveSubscriptions()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('removes the lease it wrote at shutdown after a failed renewal', async () => {
  const harness = createHarness();

  await startReady(harness);
  harness.terminal.failNext('label');
  await vi.advanceTimersByTimeAsync(leaseRenewalMilliseconds);
  await settle();

  expect(harness.terminal.labels['tau.inbox']).toBe(
    leaseOf(sessionId, now + leaseLifetimeMilliseconds),
  );

  await harness.watch.stop();

  expect(harness.terminal.labels['tau.inbox']).toBeUndefined();
});

it('writes nothing at shutdown before the subscription is ready', async () => {
  const harness = createHarness();

  await harness.watch.start({ sessionId, context });
  await harness.watch.stop();

  expect(harness.terminal.calls).toEqual([]);
});

it('does not wake when the session stops during the startup wait', async ({ onTestFinished }) => {
  const harness = createHarness();

  await queueMessage(harness.terminal, onTestFinished);
  harness.startup.hold();
  await harness.watch.start({ sessionId, context });
  harness.fake.ready();
  await harness.startup.reached(1);

  const stopped = harness.watch.stop();

  harness.startup.release();
  await stopped;
  await settle();

  expect(harness.messages).toEqual([]);
});

it('keeps a lease another session wrote at shutdown', async () => {
  const harness = createHarness();
  const other = leaseOf('session-2', now + leaseLifetimeMilliseconds);

  await startReady(harness);

  harness.terminal.labels['tau.inbox'] = other;

  await harness.watch.stop();

  expect(harness.terminal.labels['tau.inbox']).toBe(other);
});

it('removes its lease at shutdown only after an in-flight renewal lands', async () => {
  const harness = createHarness();

  await startReady(harness);

  const renewal = harness.terminal.hold(isLeaseWrite);

  await vi.advanceTimersByTimeAsync(leaseRenewalMilliseconds);
  await renewal.entered;

  const stopped = harness.watch.stop();

  await settle();
  renewal.release();
  await stopped;

  expect(harness.terminal.labels['tau.inbox']).toBeUndefined();
});

it('ends a hung shutdown cleanup after the cleanup bound', async () => {
  const harness = createHarness();

  await startReady(harness);

  const read = harness.terminal.hold(isGet);
  let finished = false;

  const stopped = (async () => {
    await harness.watch.stop();
    finished = true;
  })();

  await read.entered;
  await vi.advanceTimersByTimeAsync(leaseCleanupMilliseconds - 1);

  expect(finished).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await stopped;

  expect(finished).toBe(true);
});

it('waits for the previous lease to drain before starting a replacement', async () => {
  const harness = createHarness();

  await startReady(harness);

  const read = harness.terminal.hold(isGet);
  const replacement = harness.watch.start({ sessionId: 'session-2', context });

  await read.entered;

  expect(harness.fake.subscribeCalls).toHaveLength(1);

  read.release();
  await replacement;
  harness.fake.ready();
  await settle();

  expect(harness.fake.subscribeCalls).toHaveLength(2);
  expect(harness.terminal.labels['tau.inbox']).toMatch(/^session-2:/);

  await harness.watch.stop();
});

it('starts no replacement when the watch stops while the previous lease drains', async () => {
  const harness = createHarness();

  await startReady(harness);

  const read = harness.terminal.hold(isGet);
  const replacement = harness.watch.start({ sessionId: 'session-2', context });

  await read.entered;

  const stopped = harness.watch.stop();

  read.release();
  await replacement;
  await stopped;

  expect(harness.fake.subscribeCalls).toHaveLength(1);
});

it('starts nothing without a terminal address', async () => {
  const fake = createHcFake();

  const watch = createInboxWatch({
    hc: { exec: fake.exec, connect: fake.connect, cwd: '/repository' },
    subscribe: fake.subscribe,
    terminal: () => undefined,
    gate: createGate().gate,
    wake: () => undefined,
    notify: () => undefined,
  });

  await watch.start({ sessionId, context });
  watch.requestScan();

  expect(fake.subscribeCalls).toEqual([]);
  expect(fake.calls).toEqual([]);
});

it('coalesces scans requested while a scan runs', async () => {
  const harness = createHarness();

  await harness.watch.start({ sessionId, context });
  harness.fake.ready();
  harness.watch.requestScan();
  harness.watch.requestScan();
  await settle();

  expect(harness.terminal.getCalls()).toBe(2);

  await harness.watch.stop();
});

it('scans on a labels event and a missed snapshot but not on other events', async () => {
  const harness = createHarness();

  await startReady(harness);

  expect(harness.terminal.getCalls()).toBe(1);

  harness.fake.emitEvent({ method: 'event', type: 'labels' });
  await settle();

  expect(harness.terminal.getCalls()).toBe(2);

  harness.fake.emitEvent({ method: 'missed' });
  await settle();

  expect(harness.terminal.getCalls()).toBe(3);

  harness.fake.emitEvent({ method: 'event', type: 'status' });
  harness.fake.emitEvent({ method: 'heartbeat' });
  await settle();

  expect(harness.terminal.getCalls()).toBe(3);

  await harness.watch.stop();
});
