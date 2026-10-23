import type { setTimeout as promiseDelay } from 'node:timers/promises';

const abortError = (signal: AbortSignal) =>
  Object.assign(new Error('The operation was aborted', { cause: signal.reason }), {
    name: 'AbortError',
  });

// Fake timers do not patch node:timers/promises. A test that mocks that module with this delay
// moves production poll waits onto the global timer, which the test can fake.
export const globalTimerDelay = (<T>(
  milliseconds?: number,
  value?: T,
  options?: { signal?: AbortSignal },
) =>
  new Promise<T | undefined>((resolve, reject) => {
    const signal = options?.signal;

    if (signal?.aborted === true) {
      reject(abortError(signal));

      return;
    }

    const onAbort = () => {
      clearTimeout(timer);

      if (signal !== undefined) {
        reject(abortError(signal));
      }
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    }, milliseconds);

    signal?.addEventListener('abort', onAbort, { once: true });
  })) as typeof promiseDelay;
