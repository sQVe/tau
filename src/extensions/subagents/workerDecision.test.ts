import { expect, it } from 'vitest';

import type { SavedQuestion, SavedReport } from './assignment.js';
import { decideWorkerDelivery, questionKey, reportKey } from './workerDecision.js';
import type { WorkerDecisionFacts, WorkerDeliveryPlan, WorkerReadFact } from './workerDecision.js';

const report = (summary: string): SavedReport => ({
  outcome: 'success',
  summary,
  evidence: [],
});

const question = (questionId: string, text: string): SavedQuestion => ({
  questionId,
  text,
  askedAt: 1,
});

const assignment = (
  assignmentId: string,
  saved: { report?: SavedReport | null; questions?: SavedQuestion[] },
): WorkerReadFact => ({
  kind: 'assignment',
  assignmentId,
  address: 't-child',
  report: saved.report ?? null,
  questions: saved.questions ?? [],
});

it.each<{
  name: string;
  facts: WorkerDecisionFacts;
  expected: WorkerDeliveryPlan;
}>([
  {
    name: 'shows a new report once',
    facts: {
      shownKeys: [],
      facts: [assignment('assignment-a', { report: report('first') })],
    },
    expected: {
      reports: [{ assignmentId: 'assignment-a', report: report('first') }],
      questions: [],
      errors: [],
    },
  },
  {
    name: 'does not show a report whose key is shown',
    facts: {
      shownKeys: [reportKey('assignment-a')],
      facts: [assignment('assignment-a', { report: report('first') })],
    },
    expected: { reports: [], questions: [], errors: [] },
  },
  {
    name: 'shows a second report whose ID is not shown',
    facts: {
      shownKeys: [reportKey('assignment-a')],
      facts: [assignment('assignment-b', { report: report('second') })],
    },
    expected: {
      reports: [{ assignmentId: 'assignment-b', report: report('second') }],
      questions: [],
      errors: [],
    },
  },
  {
    name: 'shows one report when two children share an assignment ID',
    facts: {
      shownKeys: [],
      facts: [
        assignment('assignment-a', { report: report('first') }),
        assignment('assignment-a', { report: report('first') }),
      ],
    },
    expected: {
      reports: [{ assignmentId: 'assignment-a', report: report('first') }],
      questions: [],
      errors: [],
    },
  },
  {
    name: 'shows one question when two children share an assignment ID',
    facts: {
      shownKeys: [],
      facts: [
        assignment('assignment-a', { questions: [question('q-1', 'Which branch?')] }),
        assignment('assignment-a', { questions: [question('q-1', 'Which branch?')] }),
      ],
    },
    expected: {
      reports: [],
      questions: [
        {
          assignmentId: 'assignment-a',
          address: 't-child',
          question: question('q-1', 'Which branch?'),
        },
      ],
      errors: [],
    },
  },
  {
    name: 'shows a new question once with its worker address',
    facts: {
      shownKeys: [],
      facts: [assignment('assignment-a', { questions: [question('q-1', 'Which branch?')] })],
    },
    expected: {
      reports: [],
      questions: [
        {
          assignmentId: 'assignment-a',
          address: 't-child',
          question: question('q-1', 'Which branch?'),
        },
      ],
      errors: [],
    },
  },
  {
    name: 'does not show a question already in the shown keys',
    facts: {
      shownKeys: [questionKey('assignment-a', 'q-1')],
      facts: [assignment('assignment-a', { questions: [question('q-1', 'Which branch?')] })],
    },
    expected: { reports: [], questions: [], errors: [] },
  },
  {
    name: 'shows a second question of the same assignment',
    facts: {
      shownKeys: [questionKey('assignment-a', 'q-1')],
      facts: [
        assignment('assignment-a', {
          questions: [question('q-1', 'Which branch?'), question('q-2', 'Which file?')],
        }),
      ],
    },
    expected: {
      reports: [],
      questions: [
        {
          assignmentId: 'assignment-a',
          address: 't-child',
          question: question('q-2', 'Which file?'),
        },
      ],
      errors: [],
    },
  },
  {
    name: 'does not show a question whose ID is shown under another assignment',
    facts: {
      shownKeys: [questionKey('assignment-b', 'q-1')],
      facts: [assignment('assignment-a', { questions: [question('q-1', 'Which branch?')] })],
    },
    expected: {
      reports: [],
      questions: [
        {
          assignmentId: 'assignment-a',
          address: 't-child',
          question: question('q-1', 'Which branch?'),
        },
      ],
      errors: [],
    },
  },
  {
    name: 'shows a report and a question of the same assignment',
    facts: {
      shownKeys: [],
      facts: [
        assignment('assignment-a', {
          report: report('first'),
          questions: [question('q-1', 'Which branch?')],
        }),
      ],
    },
    expected: {
      reports: [{ assignmentId: 'assignment-a', report: report('first') }],
      questions: [
        {
          assignmentId: 'assignment-a',
          address: 't-child',
          question: question('q-1', 'Which branch?'),
        },
      ],
      errors: [],
    },
  },
  {
    name: 'shows nothing for an assignment with no report and no questions',
    facts: {
      shownKeys: [],
      facts: [assignment('assignment-a', {})],
    },
    expected: { reports: [], questions: [], errors: [] },
  },
  {
    name: 'skips a child without an assignment label',
    facts: {
      shownKeys: [],
      facts: [{ kind: 'skip' }],
    },
    expected: { reports: [], questions: [], errors: [] },
  },
  {
    name: 'reports a missing assignment file as an error',
    facts: {
      shownKeys: [],
      facts: [{ kind: 'error', message: 'Missing assignment file: /agent/assignment.json.' }],
    },
    expected: {
      reports: [],
      questions: [],
      errors: ['Missing assignment file: /agent/assignment.json.'],
    },
  },
  {
    name: 'reports a malformed assignment file as an error',
    facts: {
      shownKeys: [],
      facts: [{ kind: 'error', message: 'Malformed assignment /agent/assignment.json: not JSON.' }],
    },
    expected: {
      reports: [],
      questions: [],
      errors: ['Malformed assignment /agent/assignment.json: not JSON.'],
    },
  },
])('$name', ({ facts, expected }) => {
  expect(decideWorkerDelivery(facts)).toStrictEqual(expected);
});
