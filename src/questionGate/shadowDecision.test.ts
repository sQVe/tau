import { array, assert, integer, property } from 'fast-check';
import { expect, it } from 'vitest';

import {
  shadowBatchIntervalMilliseconds,
  shadowDecision,
  shadowEligibility,
} from './shadowDecision.ts';
import type { ShadowDecision, ShadowQuestionFacts } from './shadowDecision.ts';

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

const sample: ShadowDecision = { kind: 'sample' };

const skip = (reason: Extract<ShadowDecision, { kind: 'skip' }>['reason']): ShadowDecision => ({
  kind: 'skip',
  reason,
});

it.each([
  {
    name: 'samples a single explicit choice with one recommendation and no preview',
    questions: [eligible()],
    lastBatchStartedAt: undefined,
    now: 0,
    expected: sample,
  },
  {
    name: 'refuses more than one question',
    questions: [eligible(), eligible()],
    lastBatchStartedAt: undefined,
    now: 0,
    expected: skip('multipleQuestions'),
  },
  {
    name: 'refuses a question without a kind',
    questions: [eligible({ kind: undefined })],
    lastBatchStartedAt: undefined,
    now: 0,
    expected: skip('kindMissing'),
  },
  {
    name: 'refuses an approval question',
    questions: [eligible({ kind: 'approval' })],
    lastBatchStartedAt: undefined,
    now: 0,
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
    lastBatchStartedAt: undefined,
    now: 0,
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
    lastBatchStartedAt: undefined,
    now: 0,
    expected: skip('manyRecommendations'),
  },
  {
    name: 'refuses a question preview',
    questions: [eligible({ preview: 'draft' })],
    lastBatchStartedAt: undefined,
    now: 0,
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
    lastBatchStartedAt: undefined,
    now: 0,
    expected: skip('optionPreview'),
  },
  {
    name: 'refuses a multi-select question',
    questions: [eligible({ multiSelect: true })],
    lastBatchStartedAt: undefined,
    now: 0,
    expected: skip('multiSelect'),
  },
  {
    name: 'samples when no batch started before',
    questions: [eligible()],
    lastBatchStartedAt: undefined,
    now: 1_000,
    expected: sample,
  },
  {
    name: 'refuses a batch one millisecond inside the interval',
    questions: [eligible()],
    lastBatchStartedAt: 1_000,
    now: 1_000 + shadowBatchIntervalMilliseconds - 1,
    expected: skip('recentBatch'),
  },
  {
    name: 'samples a batch at the interval boundary',
    questions: [eligible()],
    lastBatchStartedAt: 1_000,
    now: 1_000 + shadowBatchIntervalMilliseconds,
    expected: sample,
  },
  {
    name: 'samples a batch after the interval',
    questions: [eligible()],
    lastBatchStartedAt: 1_000,
    now: 1_000 + shadowBatchIntervalMilliseconds + 1,
    expected: sample,
  },
] as const)('$name', ({ questions, lastBatchStartedAt, now, expected }) => {
  expect(shadowDecision({ questions, lastBatchStartedAt, now })).toEqual(expected);
});

it('checks eligibility without the batch interval', () => {
  expect(shadowEligibility([eligible()])).toEqual(sample);
  expect(shadowEligibility([eligible({ kind: 'approval' })])).toEqual(skip('kindApproval'));
});

it('starts accepted batches at least 60 seconds apart', () => {
  assert(
    property(array(integer({ min: 0, max: 120_000 }), { maxLength: 40 }), (gaps) => {
      let now = 0;
      let lastBatchStartedAt: number | undefined;

      for (const gap of gaps) {
        now += gap;

        const decision = shadowDecision({
          questions: [eligible()],
          lastBatchStartedAt,
          now,
        });

        if (decision.kind === 'skip') {
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
