import { expect, it } from 'vitest';

import type { JudgeVerdict, PastOutcome } from '../src/questionGate/questionGate.ts';
import type { SkippedQuestions } from './questionGateScore/questionGateScoreLog.ts';
import {
  formatPanelMemberErrors,
  formatScoreReport,
  panelMemberErrorCounts,
  scoreCutoffs,
  scoreReport,
  wilsonLowerBound,
} from './questionGateScore/questionGateScoreReport.ts';
import type {
  JudgeVariant,
  PanelMemberError,
  ScoreInput,
  ScoreItem,
  ScoreReport,
  VariantScore,
} from './questionGateScore/questionGateScoreReport.ts';

const skipped = (overrides: Partial<SkippedQuestions> = {}): SkippedQuestions => ({
  malformedLines: 0,
  copiedEntries: 0,
  declinedCalls: 0,
  failedCalls: 0,
  unansweredCalls: 0,
  unmatchedResults: 0,
  ambiguousEntries: 0,
  malformedAnswers: 0,
  noRecommendation: 0,
  multiSelect: 0,
  preview: 0,
  ...overrides,
});

const answered = (confidence: number): Record<JudgeVariant, JudgeVerdict> => ({
  classifier: { kind: 'answered', confidence },
  classifierExamples: { kind: 'answered', confidence },
  panel: { kind: 'answered', confidence },
  panelExamples: { kind: 'answered', confidence },
});

const sameVerdict = (verdict: JudgeVerdict): Record<JudgeVariant, JudgeVerdict> => ({
  classifier: verdict,
  classifierExamples: verdict,
  panel: verdict,
  panelExamples: verdict,
});

const item = (fields: Partial<ScoreItem> = {}): ScoreItem => ({
  session: '/logs/tuning.jsonl',
  split: 'tuning',
  outcome: { kind: 'recommended' },
  verdicts: answered(1),
  ...fields,
});

const typedMiss: PastOutcome = { kind: 'typed', text: 'MySQL' };

const holdoutMiss = (session = '/logs/holdout.jsonl') =>
  item({ session, split: 'holdout', outcome: typedMiss });

const input = (items: ScoreItem[], overrides: Partial<ScoreInput> = {}): ScoreInput => ({
  models: {
    classifier: 'tau-fixture/judge-a',
    panel: ['tau-fixture/judge-b', 'tau-fixture/judge-c', 'tau-fixture/judge-d'],
  },
  skipped: skipped(),
  items,
  ...overrides,
});

const variant = (report: ScoreReport, name: JudgeVariant): VariantScore => {
  const found = report.variants.find((entry) => entry.variant === name);

  if (found === undefined) {
    throw new Error(`missing ${name}`);
  }

  return found;
};

it('computes the Wilson lower bound', () => {
  expect(wilsonLowerBound(95, 100)).toBeCloseTo(0.888, 3);
  expect(wilsonLowerBound(0, 0)).toBe(0);
});

it('lowers agreement when a decided item is typed', () => {
  const report = scoreReport(input([item(), item({ outcome: typedMiss })]));
  const [firstCutoff] = variant(report, 'classifier').cutoffs;

  expect(firstCutoff?.decided).toBe(2);
  expect(firstCutoff?.agreement).toBe(0.5);
});

it('takes the cutoff from tuning items only', () => {
  const tuningHits = Array.from({ length: 19 }, () => item({ verdicts: answered(0.9) }));
  const tuningMiss = item({ outcome: typedMiss, verdicts: answered(0.9) });
  const heldOutMisses = Array.from({ length: 50 }, () => holdoutMiss());
  const report = scoreReport(input([...tuningHits, tuningMiss, ...heldOutMisses]));
  const classifier = variant(report, 'classifier');

  expect(classifier.cutoff).toBe(0.5);
  expect(classifier.heldOut?.meetsBar).toBe(false);
});

it('gives no cutoff and no held-out line with fewer than 20 decided tuning items', () => {
  const tuning = Array.from({ length: 19 }, () => item());
  const heldOut = Array.from({ length: 30 }, () => holdoutMiss());
  const report = scoreReport(input([...tuning, ...heldOut]));

  expect(variant(report, 'classifier').cutoff).toBeUndefined();
  expect(formatScoreReport(report)).not.toContain('Held out');
});

it('one held-out session with many hits misses the bar', () => {
  const tuning = Array.from({ length: 20 }, () => item());

  const heldOut = Array.from({ length: 73 }, () =>
    item({ session: '/logs/holdout.jsonl', split: 'holdout' }),
  );

  const report = scoreReport(input([...tuning, ...heldOut]));
  const heldOutScore = variant(report, 'classifier').heldOut;

  expect(heldOutScore?.lowerBound).toBeGreaterThanOrEqual(0.95);
  expect(heldOutScore?.sessions).toBe(1);
  expect(heldOutScore?.sessionLowerBound).toBe(0);
  expect(heldOutScore?.meetsBar).toBe(false);
  expect(formatScoreReport(report)).toContain('over 1 session');
});

it.for<[string, number, number, number, boolean]>([
  ['600 one-hit sessions', 600, 0, 600, true],
  ['599 one-hit sessions', 599, 0, 599, false],
  ['95 hits and 5 misses over 100 sessions', 95, 5, 100, false],
])('reports whether held-out hits meet the 95% bar: %s', ([, hits, misses, sessions, meetsBar]) => {
  const tuning = Array.from({ length: 20 }, () => item());

  const heldOutHits = Array.from({ length: hits }, (_, index) =>
    item({ session: `/logs/holdout-${index}.jsonl`, split: 'holdout' }),
  );

  const heldOutMisses = Array.from({ length: misses }, (_, index) =>
    holdoutMiss(`/logs/holdout-miss-${index}.jsonl`),
  );

  const report = scoreReport(input([...tuning, ...heldOutHits, ...heldOutMisses]));
  const heldOut = variant(report, 'classifier').heldOut;

  expect(heldOut?.sessions).toBe(sessions);
  expect(heldOut?.meetsBar).toBe(meetsBar);
});

it('counts timeout and unavailable verdicts and does not decide them', () => {
  const timeout = item({ verdicts: sameVerdict({ kind: 'timeout' }) });
  const unavailable = item({ verdicts: sameVerdict({ kind: 'unavailable' }) });
  const report = scoreReport(input([timeout, unavailable]));
  const classifier = variant(report, 'classifier');

  expect(classifier.verdicts).toEqual({ answered: 0, timeout: 1, error: 0, unavailable: 1 });
  expect(classifier.cutoffs.every((row) => row.decided === 0)).toBe(true);
});

it('states the exploration limits and shows every skip counter', () => {
  const report = scoreReport(input([item()], { skipped: skipped({ ambiguousEntries: 3 }) }));
  const [first, second] = formatScoreReport(report).split('\n');

  expect(first).toBe(
    'Exploration only: past logs lack question kind and full context. This sets no launch cutoff.',
  );

  expect(second).toContain('typed text');
  expect(formatScoreReport(report)).toContain('3 ambiguous entries');
});

it('prints one section per variant with decide share and agreement at every cutoff', () => {
  const text = formatScoreReport(scoreReport(input([item()])));

  for (const name of ['classifier', 'classifierExamples', 'panel', 'panelExamples']) {
    expect(text).toContain(`\n${name}\n`);
  }

  for (const cutoff of scoreCutoffs) {
    expect(text).toContain(cutoff.toFixed(2));
  }

  expect(text).toContain('decide share');
  expect(text).toContain('agreement');
});

const panelError = (model: string, message: string): PanelMemberError => ({ model, message });

it('prints one line per model with its error count and first message', () => {
  const errors = [
    panelError('openai/one', 'OpenAI API error (429): rate limit exceeded'),
    panelError('openai/two', 'Our servers are currently overloaded.'),
    panelError('openai/one', 'a later message is not shown'),
  ];

  expect(formatPanelMemberErrors(panelMemberErrorCounts(errors))).toEqual([
    'Panel member errors: openai/one: 2 errors, first: OpenAI API error (429): rate limit exceeded',
    'Panel member errors: openai/two: 1 error, first: Our servers are currently overloaded.',
  ]);
});

it('prints none when no panel member errored', () => {
  expect(formatPanelMemberErrors(panelMemberErrorCounts([]))).toEqual([
    'Panel member errors: none',
  ]);
});

it('cuts a long first message to one line', () => {
  const message = 'x'.repeat(500);

  const [line] = formatPanelMemberErrors(
    panelMemberErrorCounts([panelError('openai/one', message)]),
  );

  expect(line).toBe(`Panel member errors: openai/one: 1 error, first: ${'x'.repeat(200)}...`);
});
