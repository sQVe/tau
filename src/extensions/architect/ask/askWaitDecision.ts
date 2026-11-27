import type { HcWaitResult } from '../../../hc/hc.js';

export type AskWaitStep =
  | { kind: 'exited' }
  | { kind: 'timeout' }
  | { kind: 'waitAgain'; secondsLeft: number };

const millisecondsPerSecond = 1000;

export const askWaitStep = (result: HcWaitResult, now: number, deadline: number): AskWaitStep => {
  if (result.ended && result.reason === 'exit') {
    return { kind: 'exited' };
  }

  if (!result.ended) {
    return { kind: 'timeout' };
  }

  const millisecondsLeft = deadline - now;

  if (millisecondsLeft <= 0) {
    return { kind: 'timeout' };
  }

  return {
    kind: 'waitAgain',
    secondsLeft: Math.ceil(millisecondsLeft / millisecondsPerSecond),
  };
};
