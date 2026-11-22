import { get } from './hc.js';
import type { HcRuntime, HcTerminal } from './hc.js';
import { decideOwner } from './ownerDecision.js';

export type Ownership = 'owner' | 'notOwner' | 'noForeground';

export const ownershipTiming = {
  deadlineMilliseconds: 10_000,
  intervalMilliseconds: 200,
} as const;

const sleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const cancel = (): void => {
      clearTimeout(timeout);
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- The caller's abort reason must pass through unchanged.
      reject(signal.reason);
    };

    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, milliseconds);

    if (signal.aborted) {
      cancel();

      return;
    }

    signal.addEventListener('abort', cancel, { once: true });
  });

const readTerminal = async (
  runtime: HcRuntime,
  terminal: string,
  signal: AbortSignal,
): Promise<HcTerminal> => {
  try {
    return await get({ ...runtime, signal }, terminal);
  } catch (error) {
    signal.throwIfAborted();

    throw error;
  }
};

export const waitForOwnership = async (
  runtime: HcRuntime,
  request: { terminal: string; processGroup: number; signal: AbortSignal },
): Promise<Ownership> => {
  const { terminal, processGroup, signal } = request;
  const startedAt = performance.now();

  for (;;) {
    signal.throwIfAborted();

    if (performance.now() - startedAt >= ownershipTiming.deadlineMilliseconds) {
      return 'noForeground';
    }

    // oxlint-disable-next-line no-await-in-loop -- Each read decides whether another read is needed.
    const terminalSnapshot = await readTerminal(runtime, terminal, signal);

    signal.throwIfAborted();

    const elapsedMilliseconds = performance.now() - startedAt;

    const verdict = decideOwner({
      foregroundPid: terminalSnapshot.foreground?.pid,
      processGroup,
      elapsedMilliseconds,
      deadlineMilliseconds: ownershipTiming.deadlineMilliseconds,
    });

    if (verdict !== 'wait') {
      return verdict;
    }

    const remainingMilliseconds = ownershipTiming.deadlineMilliseconds - elapsedMilliseconds;
    const sleepMilliseconds = Math.min(ownershipTiming.intervalMilliseconds, remainingMilliseconds);

    // oxlint-disable-next-line no-await-in-loop -- A poll waits for the interval before it reads again.
    await sleep(sleepMilliseconds, signal);
  }
};
