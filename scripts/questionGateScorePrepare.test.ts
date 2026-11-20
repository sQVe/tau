import { expect, it } from 'vitest';

import type { PastOutcome } from '../src/questionGate/questionGate.ts';
import type { LoggedQuestion } from './questionGateScore/questionGateScoreLog.ts';
import { prepareScoreQuestions } from './questionGateScore/questionGateScorePrepare.ts';
import type { ScoreSelection } from './questionGateScore/questionGateScorePrepare.ts';

const hour = 3_600_000;
const since = 10 * hour;
const until = 20 * hour;

const selection = (fields: Partial<ScoreSelection> = {}): ScoreSelection => ({
  since,
  until,
  limit: 500,
  holdout: 0.5,
  ...fields,
});

const recommended: PastOutcome = { kind: 'recommended' };

const logged = (
  session: string,
  askedAt: number,
  answeredAt: number,
  question: string,
  outcome: PastOutcome = recommended,
): LoggedQuestion => ({
  session,
  askedAt,
  answeredAt,
  question: {
    question,
    problem: `${question} problem.`,
    impact: `${question} impact.`,
    options: [
      { label: 'Yes', description: 'Take it.', recommended: true },
      { label: 'No', description: 'Leave it.', recommended: false },
    ],
  },
  outcome,
});

it('takes questions from since inclusive and until exclusive by their answer time', () => {
  const records = [
    logged('/logs/alpha.jsonl', since - 2 * hour, since - hour, 'answered before since'),
    logged('/logs/alpha.jsonl', since - hour, since, 'answered at since'),
    logged('/logs/alpha.jsonl', until - 2 * hour, until - hour, 'answered before until'),
    logged('/logs/alpha.jsonl', until - 2 * hour, until, 'answered at until'),
  ];

  const prepared = prepareScoreQuestions(records, selection());

  expect(prepared.map((item) => item.question.question)).toEqual([
    'answered at since',
    'answered before until',
  ]);
});

it('takes a whole group even when it crosses the limit', () => {
  const records = [
    logged('/logs/alpha.jsonl', 11 * hour, 12 * hour, 'alpha one'),
    logged('/logs/alpha.jsonl', 12 * hour, 13 * hour, 'alpha two'),
    logged('/logs/alpha.jsonl', 13 * hour, 14 * hour, 'alpha three'),
    logged('/logs/gamma.jsonl', 14 * hour, 15 * hour, 'gamma one'),
  ];

  const prepared = prepareScoreQuestions(records, selection({ limit: 2 }));

  expect(prepared.map((item) => item.question.question)).toEqual([
    'gamma one',
    'alpha one',
    'alpha two',
    'alpha three',
  ]);
});

it('gives every question of one session group one split', () => {
  const records = [
    logged('/logs/alpha.jsonl', 11 * hour, 12 * hour, 'alpha one'),
    logged('/logs/alpha.jsonl', 12 * hour, 13 * hour, 'alpha two'),
    logged('/logs/beta.jsonl', 13 * hour, 14 * hour, 'beta one'),
  ];

  const prepared = prepareScoreQuestions(records, selection());

  expect(prepared.map((item) => [item.session, item.split])).toEqual([
    ['/logs/beta.jsonl', 'holdout'],
    ['/logs/alpha.jsonl', 'tuning'],
    ['/logs/alpha.jsonl', 'tuning'],
  ]);
});

it('gives examples from answers outside the window and from groups it does not score', () => {
  const records = [
    logged('/logs/alpha.jsonl', hour, 2 * hour, 'old answer', {
      kind: 'otherOption',
      label: 'No',
    }),
    logged('/logs/beta.jsonl', 3 * hour, 4 * hour, 'unscored answer', {
      kind: 'typed',
      text: 'Custom',
    }),
    logged('/logs/gamma.jsonl', 11 * hour, 12 * hour, 'scored answer'),
  ];

  const prepared = prepareScoreQuestions(records, selection({ limit: 1 }));

  expect(prepared.map((item) => item.question.question)).toEqual(['scored answer']);

  const [examples] = prepared.map((item) =>
    item.examples.map((example) => ({
      time: example.time,
      question: example.question.question,
      outcome: example.outcome,
    })),
  );

  expect(examples).toEqual([
    { time: hour, question: 'old answer', outcome: { kind: 'otherOption', label: 'No' } },
    { time: 3 * hour, question: 'unscored answer', outcome: { kind: 'typed', text: 'Custom' } },
  ]);
});
