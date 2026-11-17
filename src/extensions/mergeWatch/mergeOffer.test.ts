import { expect, it } from 'vitest';

import type { Coverage, ReviewSignals, TaskSignalsRead } from '../../improvement/taskSignals.js';
import { decideMergeOffer } from './mergeOffer.js';
import type { MergeOffer } from './mergeOffer.js';

const signals = (overrides: Partial<ReviewSignals> = {}): ReviewSignals => ({
  reviewRounds: 'notFired',
  feedbackRounds: 'notFired',
  checkFailures: 'notFired',
  revert: 'notFired',
  ...overrides,
});

const read = (
  overrides: Partial<ReviewSignals> = {},
  coverage: Coverage = 'complete',
): TaskSignalsRead => ({
  status: 'read',
  signals: signals(overrides),
  coverage,
});

const failed: TaskSignalsRead = { status: 'failed', reason: 'unreadable' };

const table: { name: string; read: TaskSignalsRead | undefined; offer: MergeOffer }[] = [
  {
    name: 'reports unknown when the pull request facts could not be read',
    read: undefined,
    offer: { kind: 'unknown' },
  },
  {
    name: 'reports unknown when the signal read failed',
    read: failed,
    offer: { kind: 'unknown' },
  },
  {
    name: 'reports plain when no signal fired',
    read: read(),
    offer: { kind: 'plain' },
  },
  {
    name: 'offers a review for one fired signal',
    read: read({ feedbackRounds: 'fired' }),
    offer: { kind: 'offer', signals: ['feedbackRounds'] },
  },
  {
    name: 'offers a review for a fired signal even when another is unknown',
    read: read({ feedbackRounds: 'fired', reviewRounds: 'unknown' }),
    offer: { kind: 'offer', signals: ['feedbackRounds'] },
  },
  {
    name: 'reports unknown when a signal is unknown and none fired',
    read: read({ checkFailures: 'unknown' }),
    offer: { kind: 'unknown' },
  },
  {
    name: 'offers a review for every fired signal in order',
    read: read({
      reviewRounds: 'fired',
      feedbackRounds: 'fired',
      checkFailures: 'fired',
      revert: 'fired',
    }),
    offer: {
      kind: 'offer',
      signals: ['reviewRounds', 'feedbackRounds', 'checkFailures', 'revert'],
    },
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { read: saved, offer }) => {
  expect(decideMergeOffer(saved)).toEqual(offer);
});
