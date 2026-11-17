import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { classifierTimeoutMilliseconds, classifyChoice } from './classifier.js';

const reference = 'tau-classifier-fixture/router';

const state = { brief: 'Find the parser.' };

const question = {
  instructions: 'How wide is this brief?',
  criteria: {
    narrow: 'A lookup about known code.',
    wide: 'An investigation across many files.',
  },
};

const classifier = { id: 'router' };

const answered = (label: string, confidence: number): object => ({
  stopReason: 'stop',
  answers: { choice: { type: 'choice', choice: label, probabilities: {}, confidence } },
});

const registryFixture = (found: boolean) => {
  const findOfType = vi.fn<(type: string, provider: string, id: string) => unknown>(() =>
    found ? classifier : undefined,
  );

  const classify = vi.fn<(...parameters: unknown[]) => Promise<unknown>>();

  const context = {
    modelRegistry: { findOfType, classify },
  } as unknown as Pick<ExtensionContext, 'modelRegistry'>;

  return { context, findOfType, classify };
};

it('an answered choice returns its label and confidence', async () => {
  const { context, classify } = registryFixture(true);
  classify.mockResolvedValue(answered('narrow', 0.9));

  const outcome = await classifyChoice(context, reference, state, question, undefined);

  expect(outcome).toEqual({ kind: 'answered', label: 'narrow', confidence: 0.9 });
  expect(classify).toHaveBeenCalledOnce();

  expect(classify.mock.calls[0]?.[1]).toEqual({
    state,
    questions: {
      choice: {
        type: 'choice',
        instructions: question.instructions,
        criteria: question.criteria,
      },
    },
  });
});

it('a missing classifier returns unavailable', async () => {
  const { context, classify } = registryFixture(false);

  const outcome = await classifyChoice(context, reference, state, question, undefined);

  expect(outcome).toEqual({ kind: 'unavailable' });
  expect(classify).not.toHaveBeenCalled();
});

it('an invalid reference returns unavailable', async () => {
  const { context, classify } = registryFixture(true);

  const outcome = await classifyChoice(context, 'no-provider', state, question, undefined);

  expect(outcome).toEqual({ kind: 'unavailable' });
  expect(classify).not.toHaveBeenCalled();
});

it.for([
  ['a non-stop result', () => Promise.resolve({ stopReason: 'error', answers: {} })],
  [
    'a non-choice answer',
    () =>
      Promise.resolve({
        stopReason: 'stop',
        answers: { choice: { type: 'text', text: 'narrow' } },
      }),
  ],
  ['a rejection', () => Promise.reject(new Error('offline'))],
] as const)('%s returns error', async ([, result]) => {
  const { context, classify } = registryFixture(true);
  classify.mockImplementation(result);

  const outcome = await classifyChoice(context, reference, state, question, undefined);

  expect(outcome).toEqual({ kind: 'error' });
});

it('a timeout returns timeout and aborts the classify call', async () => {
  const { context, classify } = registryFixture(true);
  vi.useFakeTimers();

  try {
    classify.mockImplementation(() => new Promise(() => {}));

    const pending = classifyChoice(context, reference, state, question, undefined);

    await vi.advanceTimersByTimeAsync(classifierTimeoutMilliseconds - 1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ kind: 'timeout' });

    const options = classify.mock.calls[0]?.[2] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('an abort returns error', async () => {
  const { context, classify } = registryFixture(true);
  classify.mockImplementation(() => new Promise(() => {}));

  const controller = new AbortController();
  const pending = classifyChoice(context, reference, state, question, controller.signal);

  controller.abort();

  expect(await pending).toEqual({ kind: 'error' });
});
