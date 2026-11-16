import { expect, it } from 'vitest';

import { decideReviewSignals, decideStoredSignals } from './signals.ts';
import type { ReviewSignals } from './signals.ts';
import type { MissingEvidence, TaskEvidence, TaskFact } from './taskFacts.ts';
import type { Coverage } from './taskMapping.ts';

const place = {
  entryId: 'e1',
  callId: 'c1',
  timestamp: '2026-11-02T18:00:00.000Z',
};

const review = (): TaskFact => ({ ...place, kind: 'reviewCapture' });

const fix = (): TaskFact => ({ ...place, kind: 'fixCapture' });

const feedback = (): TaskFact => ({ ...place, kind: 'feedbackRound', pr: 560 });

const checkFailure = (): TaskFact => ({ ...place, kind: 'checkFailure' });

const reviews = (count: number) => Array.from({ length: count }, review);

const missing = (affects: MissingEvidence['affects']): MissingEvidence => ({
  ...place,
  tool: 'code_review',
  reason: 'The call shape is unknown.',
  affects,
});

const evidence = (facts: TaskFact[], gaps: MissingEvidence[] = []): TaskEvidence => ({
  facts,
  missing: gaps,
});

const expected = (overrides: Partial<ReviewSignals>): ReviewSignals => ({
  reviewRounds: 'notFired',
  feedbackRounds: 'notFired',
  checkFailures: 'notFired',
  revert: 'notFired',
  ...overrides,
});

const allTranscriptUnknown = {
  reviewRounds: 'unknown',
  feedbackRounds: 'unknown',
  checkFailures: 'unknown',
} as const;

const table: {
  name: string;
  evidence: TaskEvidence;
  reverted: boolean | 'unknown';
  coverage?: Coverage;
  expected: ReviewSignals;
}[] = [
  {
    name: 'fires review rounds at 5 review captures',
    evidence: evidence(reviews(5)),
    reverted: false,
    expected: expected({ reviewRounds: 'fired' }),
  },
  {
    name: 'does not fire review rounds at 4 review captures',
    evidence: evidence(reviews(4)),
    reverted: false,
    expected: expected({}),
  },
  {
    name: 'does not count fix captures as review rounds',
    evidence: evidence([...reviews(4), fix(), fix()]),
    reverted: false,
    expected: expected({}),
  },
  {
    name: 'fires review rounds when the threshold is reached despite missing evidence',
    evidence: evidence(reviews(5), [missing(['reviewCapture'])]),
    reverted: false,
    expected: expected({ reviewRounds: 'fired' }),
  },
  {
    name: 'reports review rounds unknown when a review capture is missing evidence',
    evidence: evidence(reviews(4), [missing(['reviewCapture', 'fixCapture'])]),
    reverted: false,
    expected: expected({ reviewRounds: 'unknown' }),
  },
  {
    name: 'keeps review rounds known when only a fix capture is missing evidence',
    evidence: evidence(reviews(4), [missing(['fixCapture'])]),
    reverted: false,
    expected: expected({}),
  },
  {
    name: 'fires feedback rounds at 3 read rounds',
    evidence: evidence([feedback(), feedback(), feedback()]),
    reverted: false,
    expected: expected({ feedbackRounds: 'fired' }),
  },
  {
    name: 'does not fire feedback rounds at 2 read rounds',
    evidence: evidence([feedback(), feedback()]),
    reverted: false,
    expected: expected({}),
  },
  {
    name: 'fires feedback rounds when the threshold is reached despite missing evidence',
    evidence: evidence([feedback(), feedback(), feedback()], [missing(['feedbackRound'])]),
    reverted: false,
    expected: expected({ feedbackRounds: 'fired' }),
  },
  {
    name: 'reports feedback rounds unknown when a read round is missing evidence',
    evidence: evidence([feedback(), feedback()], [missing(['feedbackRound'])]),
    reverted: false,
    expected: expected({ feedbackRounds: 'unknown' }),
  },
  {
    name: 'fires full check failures at 2 failed runs',
    evidence: evidence([checkFailure(), checkFailure()]),
    reverted: false,
    expected: expected({ checkFailures: 'fired' }),
  },
  {
    name: 'does not fire full check failures at 1 failed run',
    evidence: evidence([checkFailure()]),
    reverted: false,
    expected: expected({}),
  },
  {
    name: 'fires full check failures when the threshold is reached despite missing evidence',
    evidence: evidence([checkFailure(), checkFailure()], [missing(['checkFailure'])]),
    reverted: false,
    expected: expected({ checkFailures: 'fired' }),
  },
  {
    name: 'reports full check failures unknown when a run is missing evidence',
    evidence: evidence([checkFailure()], [missing(['checkFailure'])]),
    reverted: false,
    expected: expected({ checkFailures: 'unknown' }),
  },
  {
    name: 'fires revert when a later merged PR reverted this one',
    evidence: evidence([]),
    reverted: true,
    expected: expected({ revert: 'fired' }),
  },
  {
    name: 'does not fire revert when no later merged PR reverted this one',
    evidence: evidence([]),
    reverted: false,
    expected: expected({}),
  },
  {
    name: 'reports revert unknown when the caller does not know',
    evidence: evidence([]),
    reverted: 'unknown',
    expected: expected({ revert: 'unknown' }),
  },
  {
    name: 'keeps signals whose facts are known when another fact is missing evidence',
    evidence: evidence(reviews(5), [missing(['feedbackRound'])]),
    reverted: false,
    expected: expected({ reviewRounds: 'fired', feedbackRounds: 'unknown' }),
  },
  {
    name: 'reports transcript signals unknown when no transcript maps, and fires a revert',
    evidence: evidence([]),
    reverted: true,
    coverage: 'missing',
    expected: { ...allTranscriptUnknown, revert: 'fired' },
  },
  {
    name: 'reports transcript signals unknown when no transcript maps, and no revert',
    evidence: evidence([]),
    reverted: false,
    coverage: 'missing',
    expected: { ...allTranscriptUnknown, revert: 'notFired' },
  },
  {
    name: 'reports transcript signals unknown, even with firing facts, when coverage is unknown',
    evidence: evidence([
      ...reviews(5),
      feedback(),
      feedback(),
      feedback(),
      checkFailure(),
      checkFailure(),
    ]),
    reverted: 'unknown',
    coverage: 'unknown',
    expected: { ...allTranscriptUnknown, revert: 'unknown' },
  },
  {
    name: 'decides transcript signals from the facts when only the manager transcript maps',
    evidence: evidence(reviews(5)),
    reverted: false,
    coverage: 'managerOnly',
    expected: expected({ reviewRounds: 'fired' }),
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  const facts = {
    evidence: row.evidence,
    reverted: row.reverted,
    coverage: row.coverage ?? 'complete',
  };

  expect(decideReviewSignals(facts)).toStrictEqual(row.expected);
});

const storedTable: {
  name: string;
  counts: Readonly<Record<string, number>>;
  expected: Omit<ReviewSignals, 'revert'>;
}[] = [
  {
    name: 'fires review rounds at 5 stored review captures',
    counts: { reviewCaptures: 5 },
    expected: { reviewRounds: 'fired', feedbackRounds: 'unknown', checkFailures: 'unknown' },
  },
  {
    name: 'does not fire review rounds at 4 stored review captures',
    counts: { reviewCaptures: 4 },
    expected: { reviewRounds: 'notFired', feedbackRounds: 'unknown', checkFailures: 'unknown' },
  },
  {
    name: 'fires feedback rounds at 3 stored feedback rounds',
    counts: { feedbackRounds: 3 },
    expected: { reviewRounds: 'unknown', feedbackRounds: 'fired', checkFailures: 'unknown' },
  },
  {
    name: 'does not fire feedback rounds at 2 stored feedback rounds',
    counts: { feedbackRounds: 2 },
    expected: { reviewRounds: 'unknown', feedbackRounds: 'notFired', checkFailures: 'unknown' },
  },
  {
    name: 'fires check failures at 2 stored check failures',
    counts: { checkFailures: 2 },
    expected: { reviewRounds: 'unknown', feedbackRounds: 'unknown', checkFailures: 'fired' },
  },
  {
    name: 'does not fire check failures at 1 stored check failure',
    counts: { checkFailures: 1 },
    expected: { reviewRounds: 'unknown', feedbackRounds: 'unknown', checkFailures: 'notFired' },
  },
  {
    name: 'reports an absent count as unknown',
    counts: {},
    expected: { reviewRounds: 'unknown', feedbackRounds: 'unknown', checkFailures: 'unknown' },
  },
  {
    name: 'reports all three counts not fired when all are present and low',
    counts: { reviewCaptures: 4, feedbackRounds: 2, checkFailures: 1 },
    expected: { reviewRounds: 'notFired', feedbackRounds: 'notFired', checkFailures: 'notFired' },
  },
];

it.each(storedTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(decideStoredSignals(row.counts)).toStrictEqual(row.expected);
});
