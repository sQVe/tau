import { expect, it } from 'vitest';

import { fixtureGenericLoadout, fixtureLoadout } from './fixtures/loadout.js';
import type { Task, TaskEvent } from './types.js';
import { deriveWorkerState } from './workerState.js';
import type { WorkerFacts } from './workerState.js';

const taskBase = {
  taskId: 'task-one',
  task: 'Inspect source.',
  parentSession: '/work/parent.jsonl',
  parentSessionId: 'parent-one',
  createdAt: 1000,
  deadline: 20000,
  cancellationBudget: 1000,
  monotonicDeadline: 20000,
};

const tasks: Record<'pi' | 'generic', Task> = {
  pi: {
    ...taskBase,
    version: 1,
    nativeSessionId: 'native-one',
    nativeSessionFile: '/work/native.jsonl',
    loadout: fixtureLoadout('/work'),
  },
  generic: { ...taskBase, version: 2, loadout: fixtureGenericLoadout('/work') },
};

const event = (kind: TaskEvent['kind'], stopped = false): TaskEvent => ({
  taskId: 'task-one',
  kind,
  detail: kind,
  at: 1000,
  stopped,
});

const assignment = (state: 'submitted' | 'uncertain') => ({
  intent: { taskId: 'task-one', id: 'assignment', text: 'Work.' },
  observation: { taskId: 'task-one', id: 'assignment', state, detail: 'Saved.' },
  retry: 'Never resubmit.',
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
  assignment: saved.assignment,
  pendingQuestion: saved.pendingQuestion,
  events: Object.fromEntries((saved.events ?? []).map((record) => [record.kind, record])),
});

it.each([
  {
    harness: 'pi',
    facts: facts({ events: [event('ready')] }),
    controlled: false,
    state: 'notOwned',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('parentClosed')] }),
    controlled: false,
    state: 'notOwned',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('ready')] }),
    controlled: true,
    state: 'starting',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('ready'), event('accepted')] }),
    controlled: true,
    state: 'running',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('accepted')], pendingQuestion: question }),
    controlled: true,
    state: 'awaitingReply',
  },
  {
    harness: 'pi',
    facts: facts({
      events: [event('accepted')],
      pendingQuestion: { ...question, replySaved: true },
    }),
    controlled: true,
    state: 'running',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('accepted')], report }),
    controlled: true,
    state: 'reported',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('accepted')], report }),
    controlled: false,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('accepted'), event('stopping')], report }),
    controlled: true,
    state: 'stopping',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('accepted'), event('stopping')] }),
    controlled: false,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('accepted'), event('cleanup', true)], report }),
    controlled: true,
    state: 'stopped',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('accepted'), event('settled', true)] }),
    controlled: false,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('accepted'), event('settled')] }),
    controlled: true,
    state: 'running',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('accepted'), event('startupFailure')] }),
    controlled: false,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('accepted'), event('timeout', true)] }),
    controlled: false,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('accepted'), event('timeout')] }),
    controlled: true,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('accepted'), event('cancelled')] }),
    controlled: true,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'pi',
    facts: facts({ events: [event('accepted'), event('cleanup')] }),
    controlled: true,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'generic',
    facts: facts({ events: [event('ready')] }),
    controlled: true,
    state: 'starting',
  },
  {
    harness: 'generic',
    facts: facts({ assignment: assignment('submitted') }),
    controlled: true,
    state: 'running',
  },
  {
    harness: 'generic',
    facts: facts({ assignment: assignment('uncertain') }),
    controlled: true,
    state: 'starting',
  },
  {
    harness: 'generic',
    facts: facts({ assignment: assignment('submitted'), report }),
    controlled: true,
    state: 'reported',
  },
  {
    harness: 'generic',
    facts: facts({ assignment: assignment('submitted'), report }),
    controlled: false,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'generic',
    facts: facts({ assignment: assignment('submitted'), events: [event('settled', true)] }),
    controlled: false,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'generic',
    facts: facts({ assignment: assignment('submitted'), events: [event('timeout', true)] }),
    controlled: false,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'generic',
    facts: facts({ assignment: assignment('submitted'), events: [event('stopping')] }),
    controlled: true,
    state: 'stopping',
  },
  {
    harness: 'generic',
    facts: facts({ assignment: assignment('submitted'), events: [event('cleanup', true)] }),
    controlled: false,
    state: 'stopped',
  },
] as const)(
  'derives $state for $harness with control $controlled from facts %#',
  ({ harness, facts: saved, controlled, state }) => {
    expect(deriveWorkerState(saved, tasks[harness], controlled)).toBe(state);
  },
);
