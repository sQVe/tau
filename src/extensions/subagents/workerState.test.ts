import { expect, it } from 'vitest';

import type { TaskEvent } from './types.js';
import { deriveWorkerState, showsActivity } from './workerState.js';
import type { WorkerFacts } from './workerState.js';

const event = (kind: TaskEvent['kind'], stopped = false): TaskEvent => ({
  taskId: 'task-one',
  kind,
  detail: kind,
  at: 1000,
  stopped,
});

const question = {
  version: 1 as const,
  taskId: 'task-one',
  questionId: 'question-one',
  question: 'Which source file?',
};

const report = { taskId: 'task-one', outcome: 'success' as const, summary: 'Done.', evidence: [] };

const facts = (
  saved: Omit<Partial<WorkerFacts>, 'events'> & { events?: TaskEvent[] } = {},
): WorkerFacts => ({
  report: saved.report,
  pendingQuestion: saved.pendingQuestion,
  events: Object.fromEntries((saved.events ?? []).map((record) => [record.kind, record])),
});

it.each([
  {
    facts: facts({ events: [event('ready')] }),
    controlled: false,
    state: 'notOwned',
  },
  {
    facts: facts({ events: [event('parentClosed')] }),
    controlled: false,
    state: 'notOwned',
  },
  {
    facts: facts({ events: [event('ready')] }),
    controlled: true,
    state: 'starting',
  },
  {
    facts: facts({ events: [event('ready'), event('accepted')] }),
    controlled: true,
    state: 'running',
  },
  {
    facts: facts({ events: [event('accepted')], pendingQuestion: question }),
    controlled: true,
    state: 'awaitingReply',
  },
  {
    facts: facts({
      events: [event('accepted')],
      pendingQuestion: { ...question, replySaved: true },
    }),
    controlled: true,
    state: 'running',
  },
  {
    facts: facts({ events: [event('accepted')], report }),
    controlled: true,
    state: 'reported',
  },
  {
    facts: facts({ events: [event('accepted')], report }),
    controlled: false,
    state: 'cleanupUnconfirmed',
  },
  {
    facts: facts({ events: [event('accepted'), event('stopping')], report }),
    controlled: true,
    state: 'stopping',
  },
  {
    facts: facts({ events: [event('accepted'), event('stopping')] }),
    controlled: false,
    state: 'cleanupUnconfirmed',
  },
  {
    facts: facts({ events: [event('accepted'), event('cleanup', true)], report }),
    controlled: true,
    state: 'stopped',
  },
  {
    facts: facts({ events: [event('accepted'), event('settled', true)] }),
    controlled: false,
    state: 'cleanupUnconfirmed',
  },
  {
    facts: facts({ events: [event('accepted'), event('settled')] }),
    controlled: true,
    state: 'running',
  },
  {
    facts: facts({ events: [event('accepted'), event('startupFailure')] }),
    controlled: false,
    state: 'cleanupUnconfirmed',
  },
  {
    facts: facts({ events: [event('accepted'), event('timeout', true)] }),
    controlled: false,
    state: 'cleanupUnconfirmed',
  },
  {
    facts: facts({ events: [event('accepted'), event('timeout')] }),
    controlled: true,
    state: 'cleanupUnconfirmed',
  },
  {
    facts: facts({ events: [event('accepted'), event('cancelled')] }),
    controlled: true,
    state: 'cleanupUnconfirmed',
  },
  {
    facts: facts({ events: [event('accepted'), event('cleanup')] }),
    controlled: true,
    state: 'cleanupUnconfirmed',
  },
] as const)(
  'derives $state with control $controlled from facts %#',
  ({ facts: saved, controlled, state }) => {
    expect(deriveWorkerState(saved, controlled)).toBe(state);
  },
);

it.each([
  ['starting', true],
  ['running', true],
  ['awaitingReply', true],
  ['notOwned', true],
  ['reported', false],
  ['stopping', false],
  ['stopped', false],
  ['cleanupUnconfirmed', false],
] as const)('shows activity for %s: %s', (state, shown) => {
  expect(showsActivity(state)).toBe(shown);
});
