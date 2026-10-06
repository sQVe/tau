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
  onlyParentCanClear: false,
  ...saved,
});

it.each([
  // A time blocker is accepted only strictly inside the last tenth of the window.
  { facts: facts({ blockerKind: 'time' }), step: 'refuseTime' },
  { facts: facts({ blockerKind: 'time', remaining: 360_000 }), step: 'refuseTime' },
  { facts: facts({ blockerKind: 'time', remaining: 359_999 }), step: 'accept' },
  { facts: facts({ blockerKind: 'time', remaining: -1 }), step: 'accept' },
  { facts: facts({ blockerKind: 'time', refusedBefore: true }), step: 'refuseTime' },
  { facts: facts({ blockerKind: 'time', remaining: 420_000 }), step: 'refuseTime' },
  { facts: facts({ blockerKind: 'time', remaining: 300_000 }), step: 'accept' },
  // A short window accepts a time blocker in its last 90 seconds, however small its tenth.
  {
    facts: facts({ blockerKind: 'time', window: fourMinutes, remaining: 100_000 }),
    step: 'refuseTime',
  },
  {
    facts: facts({ blockerKind: 'time', window: fourMinutes, remaining: 90_000 }),
    step: 'refuseTime',
  },
  { facts: facts({ blockerKind: 'time', window: fourMinutes, remaining: 89_999 }), step: 'accept' },
  { facts: facts({ blockerKind: 'time', window: fourMinutes, remaining: 80_000 }), step: 'accept' },
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
  // A blocker only the parent or user can clear is accepted at once; a time blocker keeps its rule.
  { facts: facts({ onlyParentCanClear: true }), step: 'accept' },
  { facts: facts({ blockerKind: 'decision', onlyParentCanClear: true }), step: 'accept' },
  { facts: facts({ blockerKind: 'limit', onlyParentCanClear: true }), step: 'accept' },
  { facts: facts({ blockerKind: 'time', onlyParentCanClear: true }), step: 'refuseTime' },
] as const)(
  'decides $step for $facts.blockerKind with $facts.remaining ms left %#',
  ({ facts: saved, step }) => {
    expect(decideIncompleteReport(saved)).toBe(step);
  },
);
