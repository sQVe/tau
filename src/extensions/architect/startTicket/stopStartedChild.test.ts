import { expect, it } from 'vitest';

import { stopStartedChild } from './stopStartedChild.js';
import type { StopStartedChildOptions } from './stopStartedChild.js';

interface Clock {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  sleeps: number[];
}

const clockOf = (start: number): Clock => {
  let current = start;
  const sleeps: number[] = [];

  return {
    now: () => current,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      current += milliseconds;
    },
    sleeps,
  };
};

const optionsOf = (
  clock: Clock,
  states: () => 'running' | 'gone' | 'unknown',
  signals: NodeJS.Signals[],
): StopStartedChildOptions => ({
  now: clock.now,
  sleep: clock.sleep,
  stateOf: states,
  signal: (_processId, signal) => signals.push(signal),
});

it('sends no SIGKILL when the process is gone after SIGTERM', async () => {
  const clock = clockOf(0);
  const signals: NodeJS.Signals[] = [];
  let probes = 0;

  const state = await stopStartedChild(
    4001,
    optionsOf(
      clock,
      () => {
        probes += 1;

        return probes === 1 ? 'running' : 'gone';
      },
      signals,
    ),
  );

  expect(state).toBe('gone');
  expect(signals).toEqual(['SIGTERM']);
});

it('sends no SIGKILL when the child adopts after SIGTERM', async () => {
  const clock = clockOf(0);
  const signals: NodeJS.Signals[] = [];
  let adopted = false;

  const state = await stopStartedChild(4005, {
    ...optionsOf(clock, () => 'running', signals),
    signal: (_processId, signal) => {
      signals.push(signal);
      adopted = signal === 'SIGTERM';
    },
    adopted: () => Promise.resolve(adopted),
  });

  expect(state).toBe('running');
  expect(signals).toEqual(['SIGTERM']);
});

it('returns gone when the process ends after SIGKILL', async () => {
  const clock = clockOf(0);
  const signals: NodeJS.Signals[] = [];
  let killed = false;

  const state = await stopStartedChild(4002, {
    ...optionsOf(clock, () => (killed ? 'gone' : 'running'), signals),
    signal: (_processId, signal) => {
      signals.push(signal);

      if (signal === 'SIGKILL') {
        killed = true;
      }
    },
  });

  expect(state).toBe('gone');
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
});

it('returns running at exactly ten seconds with the last sleep capped', async () => {
  const clock = clockOf(0);
  const signals: NodeJS.Signals[] = [];

  const state = await stopStartedChild(
    4003,
    optionsOf(clock, () => 'running', signals),
  );

  expect(state).toBe('running');
  expect(clock.now()).toBe(10_000);
  expect(clock.sleeps.at(-1)).toBe(200);
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
});

it('returns unknown for an unreadable process state', async () => {
  const clock = clockOf(0);
  const signals: NodeJS.Signals[] = [];

  const state = await stopStartedChild(
    4004,
    optionsOf(clock, () => 'unknown', signals),
  );

  expect(state).toBe('unknown');
  expect(signals).toEqual([]);
});
