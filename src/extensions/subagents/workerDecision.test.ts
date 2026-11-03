import { expect, it } from 'vitest';

import type { SavedQuestion, SavedReport } from './assignment.js';
import { decideWorkerDelivery, deadlineKey, questionKey, reportKey } from './workerDecision.js';
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
  saved: { report?: SavedReport | null; questions?: SavedQuestion[]; state?: string },
): WorkerReadFact => ({
  kind: 'assignment',
  assignmentId,
  address: 't-child',
  state: saved.state ?? 'live',
  report: saved.report ?? null,
  questions: saved.questions ?? [],
});

const table: {
  name: string;
  facts: WorkerDecisionFacts;
  expected: WorkerDeliveryPlan;
}[] = [
  {
    name: 'shows a new report once',
    facts: {
      shownKeys: [],
      facts: [assignment('assignment-a', { report: report('first') })],
    },
    expected: {
      reports: [{ assignmentId: 'assignment-a', report: report('first') }],
      questions: [],
      ended: [],
      errors: [],
    },
  },
  {
    name: 'does not show a report whose key is shown',
    facts: {
      shownKeys: [reportKey('assignment-a')],
      facts: [assignment('assignment-a', { report: report('first') })],
    },
    expected: { reports: [], questions: [], ended: [], errors: [] },
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
      ended: [],
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
      ended: [],
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
      ended: [],
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
      ended: [],
      errors: [],
    },
  },
  {
    name: 'does not show a question already in the shown keys',
    facts: {
      shownKeys: [questionKey('assignment-a', 'q-1')],
      facts: [assignment('assignment-a', { questions: [question('q-1', 'Which branch?')] })],
    },
    expected: { reports: [], questions: [], ended: [], errors: [] },
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
      ended: [],
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
      ended: [],
      errors: [],
    },
  },
  {
    name: 'shows the report and no question of an assignment that reported',
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
      questions: [],
      ended: [],
      errors: [],
    },
  },
  {
    name: 'shows nothing for an assignment with no report and no questions',
    facts: {
      shownKeys: [],
      facts: [assignment('assignment-a', {})],
    },
    expected: { reports: [], questions: [], ended: [], errors: [] },
  },
  {
    name: 'shows an ended message for a finished assignment without a report',
    facts: {
      shownKeys: [],
      facts: [assignment('assignment-a', { state: 'finished' })],
    },
    expected: {
      reports: [],
      questions: [],
      ended: [{ assignmentId: 'assignment-a', address: 't-child' }],
      errors: [],
    },
  },
  {
    name: 'shows the ended message once when two children share an assignment ID',
    facts: {
      shownKeys: [],
      facts: [
        assignment('assignment-a', { state: 'finished' }),
        assignment('assignment-a', { state: 'finished' }),
      ],
    },
    expected: {
      reports: [],
      questions: [],
      ended: [{ assignmentId: 'assignment-a', address: 't-child' }],
      errors: [],
    },
  },
  {
    name: 'does not show an ended message for a live assignment',
    facts: {
      shownKeys: [],
      facts: [assignment('assignment-a', { state: 'live' })],
    },
    expected: { reports: [], questions: [], ended: [], errors: [] },
  },
  {
    name: 'does not show an ended message when the assignment reported',
    facts: {
      shownKeys: [],
      facts: [assignment('assignment-a', { state: 'finished', report: report('first') })],
    },
    expected: {
      reports: [{ assignmentId: 'assignment-a', report: report('first') }],
      questions: [],
      ended: [],
      errors: [],
    },
  },
  {
    name: 'does not show an ended message when the report was already shown',
    facts: {
      shownKeys: [reportKey('assignment-a')],
      facts: [assignment('assignment-a', { state: 'finished', report: report('first') })],
    },
    expected: { reports: [], questions: [], ended: [], errors: [] },
  },
  {
    name: 'does not show an ended message when the deadline message is shown',
    facts: {
      shownKeys: [deadlineKey('assignment-a')],
      facts: [assignment('assignment-a', { state: 'finished' })],
    },
    expected: { reports: [], questions: [], ended: [], errors: [] },
  },
  {
    name: 'skips a child without an assignment label',
    facts: {
      shownKeys: [],
      facts: [{ kind: 'skip' }],
    },
    expected: { reports: [], questions: [], ended: [], errors: [] },
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
      ended: [],
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
      ended: [],
      errors: ['Malformed assignment /agent/assignment.json: not JSON.'],
    },
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { facts, expected }) => {
  expect(decideWorkerDelivery(facts)).toStrictEqual(expected);
});
