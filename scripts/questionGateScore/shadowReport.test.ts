import { expect, it } from 'vitest';

import type {
  JudgeVerdict,
  ShadowRecord,
  ShadowVariant,
} from '../../src/questionGate/questionGate.ts';
import { formatShadowReport, shadowReport } from './shadowReport.ts';

const cohort = 'cohort-a';

const question: ShadowRecord['question'] = {
  question: 'Which database should the service use?',
  problem: 'The service ships next week.',
  impact: 'Changing the database later moves every stored row.',
  options: [
    { label: 'Postgres', description: 'One primary.', recommended: true },
    { label: 'MySQL', description: 'One primary with another dialect.', recommended: false },
  ],
};

const answered = (confidence: number): JudgeVerdict => ({ kind: 'answered', confidence });

const judges = (milliseconds: number, confidence = 0.9): ShadowRecord['judges'] => ({
  classifier: { verdict: answered(confidence), milliseconds },
  classifierExamples: { verdict: answered(confidence), milliseconds },
  panel: { verdict: answered(confidence), milliseconds },
  panelExamples: { verdict: answered(confidence), milliseconds },
  agent: { verdict: answered(confidence), milliseconds: 0 },
});

const record = (fields: Partial<ShadowRecord> = {}): ShadowRecord => ({
  version: 1,
  kind: 'shadow',
  cohort,
  sessionId: 'session-a',
  question,
  confidence: 0.9,
  judges: judges(10),
  answer: { kind: 'answered', selected: ['Postgres'], typed: false },
  ...fields,
});

const report = (
  records: readonly ShadowRecord[],
  overrides: { cohort?: string; variant?: ShadowVariant; cutoff?: number } = {},
) =>
  shadowReport({
    records,
    cohort,
    variant: 'classifier',
    cutoff: 0.8,
    ...overrides,
  });

it('one session cannot supply many independent observations', () => {
  const hits = 73;
  const oneSession = Array.from({ length: hits }, () => record());

  const manySessions = Array.from({ length: hits }, (_, index) =>
    record({ sessionId: `session-${index}` }),
  );

  const single = report(oneSession);
  const spread = report(manySessions);

  expect(single.agreement).toBe(1);
  expect(spread.agreement).toBe(single.agreement);
  expect(single.lowerBound).toBe(0);
  expect(spread.lowerBound).toBeGreaterThan(0);
});

it('counts only records from the frozen cohort', () => {
  const other = record({ cohort: 'cohort-b' });

  expect(report([record(), other]).sampled).toBe(1);
});

it('reports no agreement and no bound without predictions', () => {
  const belowCutoff = record({ judges: judges(10, 0.2) });
  const score = report([belowCutoff]);

  expect(score.predictions).toBe(0);
  expect(score.predictionSessions).toBe(0);
  expect(score.agreement).toBeUndefined();
  expect(score.lowerBound).toBeUndefined();
  expect(score.potentialSaves).toBe(0);
});

it('counts a typed label, another option, and a decline as nonagreement', () => {
  const typed = record({
    sessionId: 'typed',
    answer: { kind: 'answered', selected: ['Postgres'], typed: true },
  });

  const otherOption = record({
    sessionId: 'other',
    answer: { kind: 'answered', selected: ['MySQL'], typed: false },
  });

  const declined = record({ sessionId: 'declined', answer: { kind: 'declined' } });

  const score = report([typed, otherOption, declined]);

  expect(score.predictions).toBe(3);
  expect(score.agreement).toBe(0);
});

it('counts a hit only for exactly one non-typed choice of the recommended label', () => {
  const both = record({
    sessionId: 'both',
    answer: { kind: 'answered', selected: ['Postgres', 'MySQL'], typed: false },
  });

  const none = record({
    sessionId: 'none',
    answer: { kind: 'answered', selected: [], typed: false },
  });

  expect(report([both, none]).agreement).toBe(0);
});

it('reports potential saves, their share, sessions, and judge time', () => {
  const first = record({ sessionId: 'first', judges: judges(10) });
  const second = record({ sessionId: 'second', judges: judges(30) });

  const belowCutoff = record({
    sessionId: 'third',
    judges: judges(50, 0.2),
    answer: { kind: 'declined' },
  });

  const score = report([first, second, belowCutoff]);

  expect(score.sampled).toBe(3);
  expect(score.predictions).toBe(2);
  expect(score.predictionSessions).toBe(2);
  expect(score.potentialSaves).toBe(2);
  expect(score.potentialSaveShare).toBeCloseTo(2 / 3);
  expect(score.meanMilliseconds).toBe(30);
  expect(score.actualSaves).toBe(0);
});

it('reports n/a for share and time without records', () => {
  const score = report([]);
  const text = formatShadowReport(score);

  expect(score.sampled).toBe(0);
  expect(score.potentialSaveShare).toBeUndefined();
  expect(score.meanMilliseconds).toBeUndefined();
  expect(text).toContain('Agreement: n/a');
  expect(text).toContain('95% lower bound: n/a');
  expect(text).toContain('Potential saves: 0 (n/a of sampled dialogs)');
  expect(text).toContain('Judge time: n/a mean');
});

it('prints one decimal place for percentages and milliseconds', () => {
  const text = formatShadowReport(report([record(), record({ sessionId: 'second' })]));

  expect(text).toContain('Agreement: 100.0%');
  expect(text).toContain('95% lower bound: 13.5%');
  expect(text).toContain('Potential saves: 2 (100.0% of sampled dialogs)');
  expect(text).toContain('Judge time: 10.0 ms mean');
});
