// Decides whether a worker report summary is short enough to accept.
// tests/structure.test.ts keeps this module pure.

export interface SummaryLengthFacts {
  // Characters in the summary the worker wrote, before the blocker is added.
  length: number;
}

export type SummaryLengthStep = 'accept' | 'refuse';

export const summaryLengthLimit = 3000;

export const decideSummaryLength = (facts: SummaryLengthFacts): SummaryLengthStep =>
  facts.length <= summaryLengthLimit ? 'accept' : 'refuse';
