import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import {
  questionLogReader,
  readLoggedQuestions,
} from './questionGateScore/questionGateScoreLog.ts';
import type { SessionLog, SkippedQuestions } from './questionGateScore/questionGateScoreLog.ts';

const at = (second: number) => `2026-11-01T10:00:${String(second).padStart(2, '0')}.000Z`;

const noSkips: SkippedQuestions = {
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
};

const header = (id = 'session-inline', parentSession?: string) =>
  JSON.stringify({
    type: 'session',
    id,
    timestamp: at(0),
    ...(parentSession === undefined ? {} : { parentSession }),
  });

const logText = (lines: string[], headerLine = header()) =>
  `${[headerLine, ...lines].join('\n')}\n`;

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

const result = (
  callId: string,
  timestamp: string,
  fields: { error?: string; details?: unknown; toolName?: string },
) =>
  JSON.stringify({
    type: 'message',
    id: `${callId}-result`,
    timestamp,
    message: {
      role: 'toolResult',
      toolCallId: callId,
      toolName: fields.toolName ?? 'ask_user_question',
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

const forkScenario = () => {
  const originalPath = '/logs/original.jsonl';

  const first = [
    call('call-first', at(1), [question()]),
    result('call-first', at(2), {
      details: answered([{ question: 'Which database?', selected: ['Postgres'], typed: false }]),
    }),
  ];

  const second = [
    call('call-second', at(3), [
      question({ question: 'Which cache?', options: [option('Postgres', true), option('Redis')] }),
    ]),
    result('call-second', at(4), {
      details: answered([{ question: 'Which cache?', selected: ['Postgres'], typed: false }]),
    }),
  ];

  return {
    originalPath,
    fork: {
      path: '/logs/fork.jsonl',
      text: logText(first, header('session-fork', originalPath)),
    },
    original: {
      path: originalPath,
      text: logText([...first, ...second], header('session-original')),
    },
  };
};

const permutations = <T>(items: readonly T[]): T[][] => {
  if (items.length <= 1) {
    return [[...items]];
  }

  const orders: T[][] = [];

  for (const [index, item] of items.entries()) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];

    for (const order of permutations(rest)) {
      orders.push([item, ...order]);
    }
  }

  return orders;
};

it('reads the recommended answer of a current-shape call', () => {
  const log = readLoggedQuestions([fixtureLog('current.jsonl')]);

  expect(log.questions).toEqual([
    {
      time: Date.parse('2026-11-01T09:00:09.000Z'),
      callTime: Date.parse('2026-11-01T09:00:01.000Z'),
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

it('keeps the question call time apart from its result time', () => {
  const log = readLoggedQuestions([
    inlineLog([
      call('call-times', at(1), [question()]),
      result('call-times', at(9), {
        details: answered([{ question: 'Which database?', selected: ['Postgres'], typed: false }]),
      }),
    ]),
  ]);

  expect(log.questions.map(({ time, callTime }) => ({ time, callTime }))).toEqual([
    { time: Date.parse(at(9)), callTime: Date.parse(at(1)) },
  ]);
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

it('keeps a legacy typed value that equals the normalized recommended label', () => {
  const log = readLoggedQuestions([
    inlineLog([
      call('call-legacy-label', at(1), [
        question({ options: [option('Postgres (Recommended)'), option('SQLite')] }),
      ]),
      result('call-legacy-label', at(2), {
        details: answered([{ question: 'Which database?', selected: ['Postgres'] }]),
      }),
    ]),
  ]);

  expect(log.questions.map((entry) => entry.outcome)).toEqual([
    { kind: 'typed', text: 'Postgres' },
  ]);
});

it('reads the same log when files arrive one at a time', () => {
  const { fork, original } = forkScenario();
  const reader = questionLogReader();

  reader.add(fork);
  reader.add(original);

  expect(reader.finish()).toEqual(readLoggedQuestions([fork, original]));
});

it('gives a fork and its original one session key', () => {
  const { fork, original } = forkScenario();
  const log = readLoggedQuestions([fork, original]);

  expect(log.questions.map((entry) => entry.session)).toEqual([fork.path, fork.path]);
  expect(log.skipped).toEqual({ ...noSkips, copiedEntries: 2 });
});

it('reads the same answers in every file order', () => {
  const { fork, original } = forkScenario();

  const other: SessionLog = {
    path: '/logs/other.jsonl',
    text: logText(
      [
        call('call-other', at(5), [
          question({
            question: 'Which queue?',
            options: [option('Postgres', true), option('SQS')],
          }),
        ]),
        result('call-other', at(6), {
          details: answered([{ question: 'Which queue?', selected: ['SQS'], typed: false }]),
        }),
      ],
      header('session-other'),
    ),
  };

  const logs = [fork, original, other];
  const expected = readLoggedQuestions(logs);

  for (const order of permutations(logs)) {
    const log = readLoggedQuestions(order);

    expect(log.questions).toEqual(expected.questions);
    expect(log.skipped).toEqual(expected.skipped);
  }
});

it('keeps positional answer slots when one is malformed', () => {
  const log = readLoggedQuestions([
    inlineLog([
      call('call-slots', at(1), [
        question(),
        question({
          question: 'Which cache?',
          options: [option('Postgres', true), option('Redis')],
        }),
        question({ question: 'Which queue?', options: [option('Postgres', true), option('SQS')] }),
      ]),
      result('call-slots', at(2), {
        details: answered([
          { question: 'Which database?', selected: ['Postgres'], typed: false },
          null,
          { question: 'Which queue?', selected: ['SQS'], typed: false },
        ]),
      }),
    ]),
  ]);

  expect(log.questions.map((entry) => entry.outcome)).toEqual([
    { kind: 'recommended' },
    { kind: 'otherOption', label: 'SQS' },
  ]);

  expect(log.skipped).toEqual({ ...noSkips, malformedAnswers: 1 });
});

it('pairs a result that appears before its call in another file', () => {
  const log = readLoggedQuestions([
    {
      path: '/logs/result.jsonl',
      text: logText(
        [
          result('call-late', at(4), {
            details: answered([
              { question: 'Which database?', selected: ['Postgres'], typed: false },
            ]),
          }),
        ],
        header('session-result'),
      ),
    },
    {
      path: '/logs/call.jsonl',
      text: logText([call('call-late', at(3), [question()])], header('session-call')),
    },
  ]);

  expect(log.questions).toHaveLength(1);
  expect(log.questions[0]?.session).toBe('/logs/result.jsonl');
  expect(log.skipped).toEqual(noSkips);
});

it('counts a named question error result that has no call', () => {
  const log = readLoggedQuestions([
    inlineLog([result('call-orphan-error', at(1), { error: 'The dialog failed.' })]),
  ]);

  expect(log).toEqual({ questions: [], skipped: { ...noSkips, unmatchedResults: 1 } });
});

it('counts an error result with valid answers as a failed call', () => {
  const log = readLoggedQuestions([
    inlineLog([
      call('call-error-answers', at(1), [question()]),
      result('call-error-answers', at(2), {
        error: 'The dialog failed.',
        details: answered([{ question: 'Which database?', selected: ['Postgres'], typed: false }]),
      }),
    ]),
  ]);

  expect(log).toEqual({ questions: [], skipped: { ...noSkips, failedCalls: 1 } });
});

it('counts an entry with an invalid timestamp as a malformed line', () => {
  const badTimestamp = JSON.stringify({
    type: 'message',
    id: 'bad-timestamp',
    timestamp: 'not-a-time',
    message: { role: 'assistant', content: [] },
  });

  const log = readLoggedQuestions([
    inlineLog([
      call('call-timed', at(1), [question()]),
      badTimestamp,
      result('call-timed', at(3), {
        details: answered([{ question: 'Which database?', selected: ['Postgres'], typed: false }]),
      }),
    ]),
  ]);

  expect(log.questions).toHaveLength(1);
  expect(log.skipped).toEqual({ ...noSkips, malformedLines: 1 });
});

it('counts a missing positional answer slot', () => {
  const log = readLoggedQuestions([
    inlineLog([
      call('call-missing-slot', at(1), [
        question(),
        question({
          question: 'Which cache?',
          options: [option('Postgres', true), option('Redis')],
        }),
      ]),
      result('call-missing-slot', at(2), {
        details: answered([{ question: 'Which database?', selected: ['Postgres'], typed: false }]),
      }),
    ]),
  ]);

  expect(log.questions.map((entry) => entry.question.question)).toEqual(['Which database?']);
  expect(log.skipped).toEqual({ ...noSkips, malformedAnswers: 1 });
});

it('rejects malformed answer fields', () => {
  const log = readLoggedQuestions([
    inlineLog([
      call('call-bad-fields', at(1), [
        question(),
        question({
          question: 'Which cache?',
          options: [option('Postgres', true), option('Redis')],
        }),
      ]),
      result('call-bad-fields', at(2), {
        details: answered([
          { question: 'Which database?', selected: ['Postgres', 3], typed: false },
          { question: 'Which cache?', selected: ['Postgres'], typed: 'yes' },
        ]),
      }),
    ]),
  ]);

  expect(log).toEqual({ questions: [], skipped: { ...noSkips, malformedAnswers: 2 } });
});

it('treats an empty parentSession as its own origin', () => {
  const path = '/logs/empty-parent.jsonl';

  const log = readLoggedQuestions([
    {
      path,
      text: logText(
        [
          call('call-empty-parent', at(1), [question()]),
          result('call-empty-parent', at(2), {
            details: answered([
              { question: 'Which database?', selected: ['Postgres'], typed: false },
            ]),
          }),
        ],
        header('session-empty-parent', ''),
      ),
    },
  ]);

  expect(log.questions.map((entry) => entry.session)).toEqual([path]);
});

it('keeps both complete pairs when two files share a call ID', () => {
  const pair = (path: string, questionText: string, label: string, start: number): SessionLog => ({
    path,
    text: logText(
      [
        call('call-shared', at(start), [
          question({
            question: questionText,
            options: [option('Postgres', true), option(label)],
          }),
        ]),
        result('call-shared', at(start + 1), {
          details: answered([{ question: questionText, selected: [label], typed: false }]),
        }),
      ],
      header(`session-${start}`),
    ),
  });

  const log = readLoggedQuestions([
    pair('/logs/a.jsonl', 'Which database?', 'SQLite', 1),
    pair('/logs/b.jsonl', 'Which cache?', 'Redis', 3),
  ]);

  expect(log.questions.map((entry) => entry.outcome)).toEqual([
    { kind: 'otherOption', label: 'SQLite' },
    { kind: 'otherOption', label: 'Redis' },
  ]);

  expect(log.questions.map((entry) => entry.session)).toEqual(['/logs/a.jsonl', '/logs/b.jsonl']);

  expect(log.skipped).toEqual(noSkips);
});

it('counts ambiguous cross-file pairs with one call ID', () => {
  const calls = [1, 2].map((start): SessionLog => ({
    path: `/logs/call-${start}.jsonl`,
    text: logText(
      [call('call-ambiguous', at(start), [question()])],
      header(`session-call-${start}`),
    ),
  }));

  const results = [3, 4].map((start): SessionLog => ({
    path: `/logs/result-${start}.jsonl`,
    text: logText(
      [
        result('call-ambiguous', at(start), {
          details: answered([
            { question: 'Which database?', selected: ['Postgres'], typed: false },
          ]),
        }),
      ],
      header(`session-result-${start}`),
    ),
  }));

  const log = readLoggedQuestions([...calls, ...results]);

  expect(log).toEqual({ questions: [], skipped: { ...noSkips, ambiguousEntries: 4 } });
});

it('gives every copy one session key when a parent is missing', () => {
  const originalPath = '/logs/original.jsonl';
  const intermediatePath = '/logs/intermediate.jsonl';
  const groupKey = '/logs/grandchild.jsonl';

  const copied = [
    call('call-copied', at(1), [question()]),
    result('call-copied', at(2), {
      details: answered([{ question: 'Which database?', selected: ['Postgres'], typed: false }]),
    }),
  ];

  const later = [
    call('call-later', at(3), [
      question({ question: 'Which cache?', options: [option('Postgres', true), option('Redis')] }),
    ]),
    result('call-later', at(4), {
      details: answered([{ question: 'Which cache?', selected: ['Postgres'], typed: false }]),
    }),
  ];

  const grandchild: SessionLog = {
    path: groupKey,
    text: logText(copied, header('session-grandchild', intermediatePath)),
  };

  const original: SessionLog = {
    path: originalPath,
    text: logText([...copied, ...later], header('session-original')),
  };

  for (const order of permutations([grandchild, original])) {
    const log = readLoggedQuestions(order);

    expect(log.questions.map((entry) => entry.session)).toEqual([groupKey, groupKey]);
  }
});

it('gives two files one session key when a copied non-question entry is their only bridge', () => {
  const bridge = JSON.stringify({
    type: 'message',
    id: 'bridge-entry',
    timestamp: at(0),
    message: { role: 'user', content: [{ type: 'text', text: 'Start here.' }] },
  });

  const database = [
    bridge,
    call('call-database', at(1), [question()]),
    result('call-database', at(2), {
      details: answered([{ question: 'Which database?', selected: ['Postgres'], typed: false }]),
    }),
  ];

  const cache = [
    bridge,
    call('call-cache', at(3), [
      question({ question: 'Which cache?', options: [option('Postgres', true), option('Redis')] }),
    ]),
    result('call-cache', at(4), {
      details: answered([{ question: 'Which cache?', selected: ['Postgres'], typed: false }]),
    }),
  ];

  const first: SessionLog = {
    path: '/logs/b-question.jsonl',
    text: logText(cache, header('session-cache')),
  };

  const second: SessionLog = {
    path: '/logs/a-question.jsonl',
    text: logText(database, header('session-database')),
  };

  for (const order of permutations([first, second])) {
    const log = readLoggedQuestions(order);

    expect(log.questions.map((entry) => entry.session)).toEqual([
      '/logs/a-question.jsonl',
      '/logs/a-question.jsonl',
    ]);

    expect(log.skipped.copiedEntries).toBe(1);
  }
});

it('keeps each outcome when a call-only copy is read first', () => {
  const originalPath = '/logs/a.jsonl';

  const databaseCall = call('shared', at(1), [
    question({ question: 'Database?', options: [option('Yes', true), option('No')] }),
  ]);

  const databaseResult = result('shared', at(2), {
    details: answered([{ question: 'Database?', selected: ['Yes'], typed: false }]),
  });

  const cacheCall = call('shared', at(3), [
    question({ question: 'Cache?', options: [option('Yes', true), option('No')] }),
  ]);

  const cacheResult = result('shared', at(4), {
    details: answered([{ question: 'Cache?', selected: ['No'], typed: false }]),
  });

  const original: SessionLog = {
    path: originalPath,
    text: logText([databaseCall, databaseResult], header('session-a')),
  };

  const branch: SessionLog = {
    path: '/logs/branch.jsonl',
    text: logText(
      [databaseCall, databaseResult, cacheCall, cacheResult],
      header('session-branch', originalPath),
    ),
  };

  const prefix: SessionLog = {
    path: '/logs/prefix-copy.jsonl',
    text: logText([databaseCall], header('session-prefix', originalPath)),
  };

  const expected = [
    ['Database?', { kind: 'recommended' }],
    ['Cache?', { kind: 'otherOption', label: 'No' }],
  ];

  for (const order of permutations([prefix, branch, original])) {
    const log = readLoggedQuestions(order);
    const seen = log.questions.map((entry) => [entry.question.question, entry.outcome]);

    expect(seen).toEqual(expected);
  }
});

it('gives surviving descendants one session key when ancestors are missing', () => {
  const originalPath = '/logs/original.jsonl';
  const intermediatePath = '/logs/intermediate.jsonl';

  const database = [
    call('database', at(1), [question({ question: 'Database?' })]),
    result('database', at(2), {
      details: answered([{ question: 'Database?', selected: ['Postgres'], typed: false }]),
    }),
  ];

  const cache = [
    call('cache', at(3), [
      question({ question: 'Cache?', options: [option('Postgres', true), option('Redis')] }),
    ]),
    result('cache', at(4), {
      details: answered([{ question: 'Cache?', selected: ['Redis'], typed: false }]),
    }),
  ];

  const grandchild: SessionLog = {
    path: '/logs/grandchild.jsonl',
    text: logText(database, header('session-grandchild', intermediatePath)),
  };

  const lateCopy: SessionLog = {
    path: '/logs/later-copy.jsonl',
    text: logText([...database, ...cache], header('session-later-copy', originalPath)),
  };

  const expected = '/logs/grandchild.jsonl';

  for (const order of permutations([grandchild, lateCopy])) {
    const log = readLoggedQuestions(order);

    expect(log.questions.map((entry) => entry.session)).toEqual([expected, expected]);
  }
});

it('counts overlapping same-ID calls in one file as ambiguous', () => {
  const databaseCall = call('shared', at(1), [
    question({ question: 'Database?', options: [option('Yes', true), option('No')] }),
  ]);

  const cacheCall = call('shared', at(3), [
    question({ question: 'Cache?', options: [option('Yes', true), option('No')] }),
  ]);

  const databaseResult = result('shared', at(5), {
    details: answered([{ question: 'Database?', selected: ['Yes'], typed: false }]),
  });

  const cacheResult = result('shared', at(6), {
    details: answered([{ question: 'Cache?', selected: ['No'], typed: false }]),
  });

  const log = readLoggedQuestions([
    {
      path: '/logs/overlap.jsonl',
      text: logText(
        [databaseCall, cacheCall, databaseResult, cacheResult],
        header('session-overlap'),
      ),
    },
  ]);

  expect(log.questions).toEqual([]);
  expect(log.skipped).toEqual({ ...noSkips, ambiguousEntries: 4 });
});
