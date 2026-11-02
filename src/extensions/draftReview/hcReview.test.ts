import { afterEach, expect, it, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { errorMessage } from '../../errors.js';
import type { HcRuntime } from '../../hc/hc.js';
import type { HcWaitResult } from '../../hc/replies.js';
import { reviewSpace, TuicrExitTimeoutError, waitForReviewExit } from './hcReview.js';

const recordDirectory = '/records/draft-review-1';

const exitRequest = { address: 't7', recordDirectory, timeoutSeconds: 1 };

const waitResult = (overrides: Partial<HcWaitResult>): HcWaitResult => ({
  terminal: 't7',
  ended: false,
  reason: 'timeout',
  turn: 1,
  children: [],
  ...overrides,
});

const message = waitResult({ reason: 'message' });

// Each hc wait call answers with the next result, so a test can script the outcomes in order.
const runtimeWithWaits = (fake: HcFake, results: HcWaitResult[]): HcRuntime => ({
  exec: (command, commandArguments, options) => {
    const next = results.shift();

    if (next !== undefined) {
      fake.reply('wait', JSON.stringify(next));
    }

    return fake.exec(command, commandArguments, options);
  },
  connect: fake.connect,
  cwd: '/repository',
});

const runtimeOf = (fake: HcFake): HcRuntime => ({
  exec: fake.exec,
  connect: fake.connect,
  cwd: '/repository',
});

const waitCallCount = (fake: HcFake): number =>
  fake.calls.filter((call) => call.commandArguments[0] === 'wait').length;

afterEach(() => {
  vi.unstubAllEnvs();
});

it('waits again after a message and returns when the terminal ends', async () => {
  const fake = createHcFake();
  const runtime = runtimeWithWaits(fake, [message, waitResult({ ended: true, reason: 'exit' })]);

  await expect(waitForReviewExit(runtime, exitRequest)).resolves.toBeUndefined();

  expect(waitCallCount(fake)).toBe(2);
});

it.each<{ name: string; results: HcWaitResult[]; calls: number }>([
  {
    name: 'five messages arrive',
    results: [message, message, message, message, message, message],
    calls: 5,
  },
  { name: 'the wait times out', results: [waitResult({ reason: 'timeout' })], calls: 1 },
  {
    name: 'the wait gives a reason it does not know',
    results: [waitResult({ reason: 'x' })],
    calls: 1,
  },
])('throws a timeout that names the record when $name', async ({ results, calls }) => {
  const fake = createHcFake();
  const runtime = runtimeWithWaits(fake, results);

  const failure = await waitForReviewExit(runtime, exitRequest).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(TuicrExitTimeoutError);
  expect(errorMessage(failure)).toContain(recordDirectory);
  expect(waitCallCount(fake)).toBe(calls);
});

it('returns the space label of the manager terminal', async () => {
  const fake = createHcFake();

  vi.stubEnv('HC_TERMINAL_ID', 't7');

  fake.reply(
    'get',
    JSON.stringify({ address: 't7', state: 'live', labels: { 'herdr.space': 'a' } }),
  );

  await expect(reviewSpace(runtimeOf(fake))).resolves.toBe('a');
});

it('returns no space without a manager terminal', async () => {
  const fake = createHcFake();

  vi.stubEnv('HC_TERMINAL_ID', undefined);

  await expect(reviewSpace(runtimeOf(fake))).resolves.toBeUndefined();
  expect(fake.calls).toHaveLength(0);
});

it('rejects a manager terminal that hc reports malformed', async () => {
  const fake = createHcFake();

  vi.stubEnv('HC_TERMINAL_ID', 't7');
  fake.reply('get', 'not-json');

  await expect(reviewSpace(runtimeOf(fake))).rejects.toMatchObject({
    name: 'HcError',
    kind: 'malformed',
  });
});

it('returns no space when the manager terminal has no space label', async () => {
  const fake = createHcFake();

  vi.stubEnv('HC_TERMINAL_ID', 't7');
  fake.reply('get', JSON.stringify({ address: 't7', state: 'live', labels: { role: 'worker' } }));

  await expect(reviewSpace(runtimeOf(fake))).resolves.toBeUndefined();
});
