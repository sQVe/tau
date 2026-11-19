import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { readLoggedQuestions } from './questionGateScoreLog.ts';
import type { SessionLog, SkippedQuestions } from './questionGateScoreLog.ts';

const at = (second: number) => `2026-11-01T10:00:${String(second).padStart(2, '0')}.000Z`;

const noSkips: SkippedQuestions = {
  malformedLines: 0,
  copiedEntries: 0,
  declinedCalls: 0,
  failedCalls: 0,
  unansweredCalls: 0,
  unmatchedResults: 0,
  malformedAnswers: 0,
  noRecommendation: 0,
  multiSelect: 0,
  preview: 0,
};

const header = JSON.stringify({ type: 'session', id: 'session-inline', timestamp: at(0) });

const logText = (lines: string[]) => `${[header, ...lines].join('\n')}\n`;

const call = (callId: string, timestamp: string, questions: unknown[]) =>
  JSON.stringify({
    type: 'message',
    id: `${callId}-call`,
    timestamp,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: callId,
          name: 'ask_user_question',
          arguments: { questions },
        },
      ],
    },
  });

const result = (callId: string, timestamp: string, fields: { error?: string; details?: unknown }) =>
  JSON.stringify({
    type: 'message',
    id: `${callId}-result`,
    timestamp,
    message: {
      role: 'toolResult',
      toolCallId: callId,
      isError: fields.error !== undefined,
      content: [{ type: 'text', text: fields.error ?? 'done' }],
      ...(fields.details === undefined ? {} : { details: fields.details }),
    },
  });

const option = (label: string, recommended = false) => ({
  label,
  description: `${label} option.`,
  recommended,
});

const question = (fields: Record<string, unknown> = {}) => ({
  question: 'Which database?',
  problem: 'The store needs a database.',
  impact: 'It sets the migration path.',
  header: 'Database',
  options: [option('Postgres', true), option('SQLite')],
  ...fields,
});

const answered = (rows: unknown[]) => ({ kind: 'answered', answers: rows });

const fixtureText = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'questionGate', name), 'utf8');

const fixtureLog = (name: string): SessionLog => ({
  path: `/logs/${name}`,
  text: fixtureText(name),
});

const inlineLog = (lines: string[], path = '/logs/inline.jsonl'): SessionLog => ({
  path,
  text: logText(lines),
});

it('reads the recommended answer of a current-shape call', () => {
  const log = readLoggedQuestions([fixtureLog('current.jsonl')]);

  expect(log.questions).toEqual([
    {
      time: Date.parse('2026-11-01T09:00:09.000Z'),
      session: '/logs/current.jsonl',
      question: {
        question: 'Which database should the service use?',
        problem: 'The service needs a database for its records.',
        impact: 'It sets the migration path and the local setup.',
        options: [
          { label: 'Postgres', description: 'Runs the production schema.', recommended: true },
          { label: 'SQLite', description: 'Keeps local setup small.', recommended: false },
        ],
      },
      outcome: { kind: 'recommended' },
    },
  ]);

  expect(log.skipped).toEqual(noSkips);
});

it('reads a typed answer from the current shape', () => {
  const log = readLoggedQuestions([
    inlineLog([
      call('call-typed', at(1), [question()]),
      result('call-typed', at(2), {
        details: answered([
          { question: 'Which database?', selected: ['A file store'], typed: true },
        ]),
      }),
    ]),
  ]);

  const outcomes = log.questions.map((entry) => entry.outcome);

  expect(outcomes).toEqual([{ kind: 'typed', text: 'A file store' }]);
});

it('counts a declined call once and reads no question', () => {
  const log = readLoggedQuestions([
    inlineLog([
      call('call-declined', at(1), [question()]),
      result('call-declined', at(2), { details: { kind: 'declined' } }),
    ]),
  ]);

  expect(log).toEqual({ questions: [], skipped: { ...noSkips, declinedCalls: 1 } });
});

it('counts a question without exactly one recommended option', () => {
  const log = readLoggedQuestions([
    inlineLog([
      call('call-unrecommended', at(1), [
        question({ options: [option('Postgres'), option('SQLite')] }),
      ]),
      result('call-unrecommended', at(2), {
        details: answered([{ question: 'Which database?', selected: ['Postgres'], typed: false }]),
      }),
    ]),
  ]);

  expect(log).toEqual({ questions: [], skipped: { ...noSkips, noRecommendation: 1 } });
});

it('counts multi-select questions and questions with a preview in their own fields', () => {
  const withOptionPreview = {
    ...option('Second'),
    preview: 'A second example.',
  };

  const log = readLoggedQuestions([
    inlineLog([
      call('call-skipped', at(1), [
        question({ question: 'Which features?', multiSelect: true }),
        question({ question: 'Which draft?', preview: 'Draft text.' }),
        question({
          question: 'Which example?',
          options: [option('First', true), withOptionPreview],
        }),
      ]),
      result('call-skipped', at(2), {
        details: answered([
          { question: 'Which features?', selected: ['Search'], typed: false },
          { question: 'Which draft?', selected: ['Postgres'], typed: false },
          { question: 'Which example?', selected: ['First'], typed: false },
        ]),
      }),
    ]),
  ]);

  expect(log).toEqual({ questions: [], skipped: { ...noSkips, multiSelect: 1, preview: 2 } });
});

it('counts a malformed line and still reads the good lines', () => {
  const log = readLoggedQuestions([fixtureLog('malformed.jsonl')]);
  const asked = log.questions.map((entry) => entry.question.question);

  expect(asked).toEqual(['Which database should we use?', 'Which cache should we add?']);
  expect(log.skipped).toEqual({ ...noSkips, malformedLines: 1 });
});

it('strips the legacy recommended suffix and reads a legacy typed value', () => {
  const log = readLoggedQuestions([fixtureLog('legacyCancelled.jsonl')]);

  const read = log.questions.map(({ question: asked, outcome }) => ({
    question: asked.question,
    problem: asked.problem,
    impact: asked.impact,
    labels: asked.options.map((candidate) => candidate.label),
    outcome,
  }));

  expect(read).toEqual([
    {
      question: 'Which cache should we add?',
      problem: 'The API repeats the same reads.',
      impact: '',
      labels: ['Redis', 'In memory'],
      outcome: { kind: 'recommended' },
    },
    {
      question: 'Which queue should we use?',
      problem: 'The worker needs a queue.',
      impact: 'It sets the retry behavior.',
      labels: ['Kafka', 'SQS'],
      outcome: { kind: 'typed', text: 'RabbitMQ' },
    },
  ]);

  expect(log.skipped).toEqual({ ...noSkips, declinedCalls: 1 });
});

it('reads the legacy questionIndex option and custom answers', () => {
  const log = readLoggedQuestions([fixtureLog('legacyIndexed.jsonl')]);
  const outcomes = log.questions.map((entry) => entry.outcome);

  expect(outcomes).toEqual([
    { kind: 'otherOption', label: 'SQLite' },
    { kind: 'typed', text: 'REST with a version prefix' },
  ]);

  expect(log.skipped).toEqual(noSkips);
});

it('reads a copied entry once and counts it in copiedEntries', () => {
  const text = fixtureText('current.jsonl');

  const log = readLoggedQuestions([
    { path: '/logs/first.jsonl', text },
    { path: '/logs/second.jsonl', text },
  ]);

  expect(log.questions).toHaveLength(1);
  expect(log.questions[0]?.session).toBe('/logs/first.jsonl');
  expect(log.skipped).toEqual({ ...noSkips, copiedEntries: 3 });
});

it('gives no questions and all counts zero for an empty file list', () => {
  expect(readLoggedQuestions([])).toEqual({ questions: [], skipped: noSkips });
});

it('counts failed, unanswered, and unmatched calls once', () => {
  const log = readLoggedQuestions([
    inlineLog([
      call('call-errored', at(1), [question()]),
      result('call-errored', at(2), { error: 'The dialog failed.' }),
      call('call-missing-answers', at(3), [question()]),
      result('call-missing-answers', at(4), { details: {} }),
      call('call-pending', at(5), [question()]),
      result('call-orphan', at(6), {
        details: answered([{ question: 'Which database?', selected: ['Postgres'], typed: false }]),
      }),
    ]),
  ]);

  expect(log).toEqual({
    questions: [],
    skipped: {
      ...noSkips,
      failedCalls: 2,
      unansweredCalls: 1,
      unmatchedResults: 1,
    },
  });
});

it('counts a malformed answer row and still reads the other question', () => {
  const log = readLoggedQuestions([
    inlineLog([
      call('call-malformed-answer', at(1), [
        question(),
        question({
          question: 'Which cache?',
          options: [option('Postgres', true), option('Redis')],
        }),
      ]),
      result('call-malformed-answer', at(2), {
        details: answered([
          { question: 'Which database?' },
          { question: 'Which cache?', selected: ['Redis'], typed: false },
        ]),
      }),
    ]),
  ]);

  expect(log.questions.map((entry) => entry.outcome)).toEqual([
    { kind: 'otherOption', label: 'Redis' },
  ]);

  expect(log.skipped).toEqual({ ...noSkips, malformedAnswers: 1 });
});
