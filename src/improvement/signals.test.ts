import { expect, it } from 'vitest';

import { decideReviewSignals } from './signals.ts';
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

const launch = (profile: string | undefined): TaskFact => ({
  ...place,
  kind: 'launch',
  profile,
  workerId: 'worker-a',
});

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
  reviewFixRounds: 'notFired',
  feedbackRounds: 'notFired',
  checkFailures: 'notFired',
  revert: 'notFired',
  qaAfterReview: 'notFired',
  ...overrides,
});

const table: {
  name: string;
  evidence: TaskEvidence;
  reverted: boolean | 'unknown';
  coverage?: Coverage;
  expected: ReviewSignals;
}[] = [
  {
    name: 'fires review fix rounds at 3 fix captures after a review capture',
    evidence: evidence([review(), fix(), fix(), fix()]),
    reverted: false,
    expected: expected({ reviewFixRounds: 'fired' }),
  },
  {
    name: 'does not fire review fix rounds at 2 fix captures',
    evidence: evidence([review(), fix(), fix()]),
    reverted: false,
    expected: expected({}),
  },
  {
    name: 'does not count fix captures before the first review capture',
    evidence: evidence([fix(), fix(), fix(), review()]),
    reverted: false,
    expected: expected({}),
  },
  {
    name: 'fires review fix rounds when the threshold is reached despite missing evidence',
    evidence: evidence([review(), fix(), fix(), fix()], [missing(['fixCapture'])]),
    reverted: false,
    expected: expected({ reviewFixRounds: 'fired' }),
  },
  {
    name: 'reports review fix rounds unknown when a fix capture is missing evidence',
    evidence: evidence([review(), fix()], [missing(['fixCapture'])]),
    reverted: false,
    expected: expected({ reviewFixRounds: 'unknown' }),
  },
  {
    name: 'reports review fix rounds unknown when a review capture is missing evidence',
    evidence: evidence([], [missing(['reviewCapture'])]),
    reverted: false,
    expected: expected({ reviewFixRounds: 'unknown', qaAfterReview: 'unknown' }),
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
    name: 'reports feedback rounds unknown when a read round is missing evidence',
    evidence: evidence([feedback()], [missing(['feedbackRound'])]),
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
    name: 'fires QA after review when a QA launch follows the last review capture',
    evidence: evidence([review(), launch('qa')]),
    reverted: false,
    expected: expected({ qaAfterReview: 'fired' }),
  },
  {
    name: 'does not fire QA after review when the QA launch comes before the review capture',
    evidence: evidence([launch('qa'), review()]),
    reverted: false,
    expected: expected({}),
  },
  {
    name: 'does not fire QA after review when there is no review capture',
    evidence: evidence([launch('qa')]),
    reverted: false,
    expected: expected({}),
  },
  {
    name: 'does not fire QA after review for a launch with another profile',
    evidence: evidence([review(), launch('worker')]),
    reverted: false,
    expected: expected({}),
  },
  {
    name: 'reports QA after review unknown when a launch profile is missing evidence',
    evidence: evidence([review()], [missing(['qaLaunch'])]),
    reverted: false,
    expected: expected({ qaAfterReview: 'unknown' }),
  },
  {
    name: 'reports QA after review unknown when a review capture is missing evidence',
    evidence: evidence([launch('qa')], [missing(['reviewCapture'])]),
    reverted: false,
    expected: expected({ reviewFixRounds: 'unknown', qaAfterReview: 'unknown' }),
  },
  {
    name: 'keeps signals whose facts are known when another fact is missing evidence',
    evidence: evidence([review(), fix(), fix(), fix()], [missing(['feedbackRound'])]),
    reverted: false,
    expected: expected({ reviewFixRounds: 'fired', feedbackRounds: 'unknown' }),
  },
  {
    name: 'reports transcript signals unknown when no transcript maps, and fires a revert',
    evidence: evidence([]),
    reverted: true,
    coverage: 'missing',
    expected: {
      reviewFixRounds: 'unknown',
      feedbackRounds: 'unknown',
      checkFailures: 'unknown',
      revert: 'fired',
      qaAfterReview: 'unknown',
    },
  },
  {
    name: 'reports transcript signals unknown when no transcript maps, and no revert',
    evidence: evidence([]),
    reverted: false,
    coverage: 'missing',
    expected: {
      reviewFixRounds: 'unknown',
      feedbackRounds: 'unknown',
      checkFailures: 'unknown',
      revert: 'notFired',
      qaAfterReview: 'unknown',
    },
  },
  {
    name: 'reports transcript signals unknown, even with firing facts, when coverage is unknown',
    evidence: evidence([
      review(),
      fix(),
      fix(),
      fix(),
      checkFailure(),
      checkFailure(),
      launch('qa'),
    ]),
    reverted: 'unknown',
    coverage: 'unknown',
    expected: {
      reviewFixRounds: 'unknown',
      feedbackRounds: 'unknown',
      checkFailures: 'unknown',
      revert: 'unknown',
      qaAfterReview: 'unknown',
    },
  },
  {
    name: 'decides transcript signals from the facts when only the manager transcript maps',
    evidence: evidence([review(), fix(), fix(), fix()]),
    reverted: false,
    coverage: 'managerOnly',
    expected: expected({ reviewFixRounds: 'fired' }),
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
