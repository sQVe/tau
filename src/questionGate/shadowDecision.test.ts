import { array, assert, integer, property } from 'fast-check';
import { expect, it } from 'vitest';

import {
  shadowBatchIntervalMilliseconds,
  shadowEligibility,
  shadowRateAllows,
} from './shadowDecision.ts';
import type { ShadowEligibility, ShadowQuestionFacts } from './shadowDecision.ts';

const eligible = (overrides: Partial<ShadowQuestionFacts> = {}): ShadowQuestionFacts => ({
  kind: 'choice',
  multiSelect: false,
  preview: undefined,
  options: [
    { recommended: true, preview: undefined },
    { recommended: false, preview: undefined },
  ],
  ...overrides,
});

const selected = eligible();

const sample: ShadowEligibility<ShadowQuestionFacts> = { kind: 'eligible', question: selected };

const skip = (
  reason: Extract<ShadowEligibility<ShadowQuestionFacts>, { kind: 'skip' }>['reason'],
): ShadowEligibility<ShadowQuestionFacts> => ({
  kind: 'skip',
  reason,
});

it.each([
  {
    name: 'samples a single explicit choice with one recommendation and no preview',
    questions: [selected],
    expected: sample,
  },
  {
    name: 'refuses more than one question',
    questions: [eligible(), eligible()],
    expected: skip('multipleQuestions'),
  },
  {
    name: 'refuses a question without a kind',
    questions: [eligible({ kind: undefined })],
    expected: skip('kindMissing'),
  },
  {
    name: 'refuses an approval question',
    questions: [eligible({ kind: 'approval' })],
    expected: skip('kindApproval'),
  },
  {
    name: 'refuses a question with no recommendation',
    questions: [
      eligible({
        options: [
          { recommended: false, preview: undefined },
          { recommended: false, preview: undefined },
        ],
      }),
    ],
    expected: skip('noRecommendation'),
  },
  {
    name: 'refuses a question with two recommendations',
    questions: [
      eligible({
        options: [
          { recommended: true, preview: undefined },
          { recommended: true, preview: undefined },
        ],
      }),
    ],
    expected: skip('manyRecommendations'),
  },
  {
    name: 'refuses a question preview',
    questions: [eligible({ preview: 'draft' })],
    expected: skip('questionPreview'),
  },
  {
    name: 'refuses an option preview',
    questions: [
      eligible({
        options: [
          { recommended: true, preview: 'one' },
          { recommended: false, preview: undefined },
        ],
      }),
    ],
    expected: skip('optionPreview'),
  },
  {
    name: 'refuses a multi-select question',
    questions: [eligible({ multiSelect: true })],
    expected: skip('multiSelect'),
  },
] as const)('$name', ({ questions, expected }) => {
  expect(shadowEligibility(questions)).toEqual(expected);
});

it.each([
  {
    name: 'allows a batch when no batch started before',
    lastBatchStartedAt: undefined,
    now: 1_000,
    expected: true,
  },
  {
    name: 'refuses a batch one millisecond inside the interval',
    lastBatchStartedAt: 1_000,
    now: 1_000 + shadowBatchIntervalMilliseconds - 1,
    expected: false,
  },
  {
    name: 'allows a batch at the interval boundary',
    lastBatchStartedAt: 1_000,
    now: 1_000 + shadowBatchIntervalMilliseconds,
    expected: true,
  },
  {
    name: 'allows a batch after the interval',
    lastBatchStartedAt: 1_000,
    now: 1_000 + shadowBatchIntervalMilliseconds + 1,
    expected: true,
  },
] as const)('$name', ({ lastBatchStartedAt, now, expected }) => {
  expect(shadowRateAllows(lastBatchStartedAt, now)).toBe(expected);
});

it('starts accepted batches at least 60 seconds apart', () => {
  assert(
    property(array(integer({ min: 0, max: 120_000 }), { maxLength: 40 }), (gaps) => {
      let now = 0;
      let lastBatchStartedAt: number | undefined;

      for (const gap of gaps) {
        now += gap;

        const eligibility = shadowEligibility([eligible()]);

        if (eligibility.kind === 'skip') {
          continue;
        }

        if (!shadowRateAllows(lastBatchStartedAt, now)) {
          continue;
        }

        const tooSoon =
          lastBatchStartedAt !== undefined &&
          now - lastBatchStartedAt < shadowBatchIntervalMilliseconds;

        expect(tooSoon).toBe(false);

        lastBatchStartedAt = now;
      }

      return true;
    }),
  );
});
