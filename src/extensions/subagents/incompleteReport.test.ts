import { expect, it } from 'vitest';

import { decideIncompleteReport } from './incompleteReport.js';
import type { IncompleteReportFacts } from './incompleteReport.js';

const hour = 3_600_000;
const fourMinutes = 240_000;

const facts = (saved: Partial<IncompleteReportFacts> = {}): IncompleteReportFacts => ({
  blockerKind: 'dependency',
  remaining: hour,
  window: hour,
  refusedBefore: false,
  ...saved,
});

it.each([
  // A time blocker is accepted only strictly inside the last tenth of the window.
  { facts: facts({ blockerKind: 'time' }), step: 'refuseTime' },
  { facts: facts({ blockerKind: 'time', remaining: 360_000 }), step: 'refuseTime' },
  { facts: facts({ blockerKind: 'time', remaining: 359_999 }), step: 'accept' },
  { facts: facts({ blockerKind: 'time', remaining: -1 }), step: 'accept' },
  { facts: facts({ blockerKind: 'time', refusedBefore: true }), step: 'refuseTime' },
  {
    facts: facts({ blockerKind: 'time', window: fourMinutes, remaining: 24_000 }),
    step: 'refuseTime',
  },
  { facts: facts({ blockerKind: 'time', window: fourMinutes, remaining: 23_999 }), step: 'accept' },
  // Other kinds are refused once while a fifth of the window, and at least five minutes, remain.
  { facts: facts(), step: 'refuseFirst' },
  { facts: facts({ blockerKind: 'decision' }), step: 'refuseFirst' },
  { facts: facts({ blockerKind: 'limit' }), step: 'refuseFirst' },
  { facts: facts({ remaining: 720_000 }), step: 'refuseFirst' },
  { facts: facts({ remaining: 719_999 }), step: 'accept' },
  { facts: facts({ refusedBefore: true }), step: 'accept' },
  { facts: facts({ window: fourMinutes, remaining: 300_000 }), step: 'refuseFirst' },
  { facts: facts({ window: fourMinutes, remaining: 299_999 }), step: 'accept' },
  { facts: facts({ window: fourMinutes, remaining: 207_000 }), step: 'accept' },
] as const)(
  'decides $step for $facts.blockerKind with $facts.remaining ms left %#',
  ({ facts: saved, step }) => {
    expect(decideIncompleteReport(saved)).toBe(step);
  },
);
