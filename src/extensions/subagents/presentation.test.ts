import { expect, it } from 'vitest';

import { modelEvidenceNotice, modelReply, modelStatus } from './presentation.js';
import type { WorkerState } from './types.js';

const states: WorkerState[] = [
  'starting',
  'running',
  'awaitingReply',
  'reported',
  'stopping',
  'stopped',
  'cleanupUnconfirmed',
  'notOwned',
];

const cleanupStates = new Set<WorkerState>(['cleanupUnconfirmed', 'notOwned']);

// A full status carries every excluded field the model must never read.
const fullStatus = (state: WorkerState, generic: boolean) => ({
  taskId: 'task-1',
  name: 'worker-ab',
  state,
  outcome: 'success',
  deadline: 1_700_000_000_000,
  predecessorTaskId: 'predecessor-1',
  successorTaskId: 'successor-1',
  report: {
    taskId: 'task-1',
    outcome: 'success',
    summary: 'Finished in /abs/report/place.',
    evidence: ['/abs/report/evidence.ts:1'],
  },
  pendingQuestion: {
    version: 1,
    taskId: 'task-1',
    questionId: 'question-1',
    question: 'Which file?',
  },
  failure: 'Startup failed.',
  cleanup: 'Cleanup detail.',
  questionReceipt: {
    question: { questionId: 'question-1' },
    reply: { replyId: 'reply-1' },
    acknowledgement: undefined,
  },
  recovery: {
    paneId: 'pane-1',
    directory: '/abs/records/task-1',
    nativeSessionFile: '/abs/records/task-1/session.jsonl',
  },
  capacityHeld: true,
  unconfirmedChildren: [{ taskId: 'child-1', directory: '/abs/records/child-1' }],
  descendantEvidence: 'Descendant reservation evidence unavailable.',
  ...(generic ? { nativeState: 'blocked' } : {}),
  submissionReceipt: { intent: { id: 'reply-one', text: 'text' }, retry: 'Never resubmit.' },
  nativeOutput: { text: 'terminal text', truncated: false, format: 'native' },
  reservationDirectory: '/abs/admission',
  usage: { available: false, reason: 'Pi reports worker usage in its own session totals.' },
  safety: 'Native controls; Tau does not certify runtime enforcement.',
  modelVerification: 'Unavailable.',
  nativeConfiguration: { cwd: '/abs/cwd' },
  directory: '/abs/records/task-1',
  nativeSessionId: 'native-1',
  nativeSessionFile: '/abs/records/task-1/session.jsonl',
  harness: generic ? 'generic' : 'pi',
  nativeKind: 'codex',
  nativeReference: { kind: 'id', value: 'opaque' },
  requestedModel: 'requested/model',
  observedModel: null,
  reportPath: '/abs/report/report.md',
  assignment: { intent: { text: 'text' }, observation: { state: 'submitted' } },
  observationIssue: 'herdr observation failed.',
});

const expectKeys = (state: WorkerState, generic: boolean) => {
  const content = modelStatus(fullStatus(state, generic));
  const cleanup = cleanupStates.has(state);
  const expected = [
    'taskId',
    'name',
    'state',
    'deadline',
    'outcome',
    'predecessorTaskId',
    'successorTaskId',
    'report',
    'pendingQuestion',
    'failure',
    'cleanup',
    'questionReceipt',
    'submissionReceipt',
    'nativeOutput',
    ...(generic ? ['nativeState'] : []),
    ...(cleanup ? ['recovery', 'capacityHeld', 'unconfirmedChildren', 'descendantEvidence'] : []),
  ];

  return { content, expected };
};

const stringValues = (value: unknown, at: string[] = []): { path: string; text: string }[] => {
  if (typeof value === 'string') {
    return [{ path: at.join('.'), text: value }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => stringValues(entry, [...at, String(index)]));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => stringValues(entry, [...at, key]));
  }

  return [];
};

it.each(states)('builds the allowlisted model content for %s', (state) => {
  for (const generic of [false, true]) {
    const { content, expected } = expectKeys(state, generic);
    expect(Object.keys(content).toSorted()).toEqual(expected.toSorted());
    expect(content.taskId).toBe('task-1');
    expect(content.state).toBe(state);
  }
});

it('keeps recovery and capacity fields only for unconfirmed or unowned states', () => {
  for (const state of states) {
    const content = modelStatus(fullStatus(state, false));
    const cleanup = cleanupStates.has(state);

    for (const key of ['recovery', 'capacityHeld', 'unconfirmedChildren', 'descendantEvidence']) {
      expect(key in content).toBe(cleanup);
    }
  }
});

it('never leaks an absolute path outside recovery and report text', () => {
  for (const state of states) {
    for (const generic of [false, true]) {
      const content = modelStatus(fullStatus(state, generic));
      const values = stringValues(content).filter(
        ({ path }) => !path.startsWith('recovery') && !path.startsWith('report'),
      );

      for (const { path, text } of values) {
        expect(text.startsWith('/'), `${path} leaked a path`).toBe(false);
      }
    }
  }
});

it('drops absent keys and maps receipts to their narrow shape', () => {
  const content = modelStatus({
    taskId: 'task-1',
    state: 'awaitingReply',
    deadline: 10,
    questionReceipt: {
      question: { questionId: 'question-1' },
      reply: { replyId: 'reply-1' },
      acknowledgement: { replyId: 'reply-1' },
    },
  });

  expect(content).toEqual({
    taskId: 'task-1',
    state: 'awaitingReply',
    deadline: 10,
    questionReceipt: {
      questionId: 'question-1',
      replyAccepted: true,
      workerAcknowledged: true,
    },
  });
});

it('shapes a submission receipt to its identity, state, and detail', () => {
  const content = modelStatus({
    taskId: 'task-1',
    state: 'running',
    deadline: 10,
    submissionReceipt: {
      intent: { id: 'reply-one', text: 'Private reply text.' },
      observation: { state: 'uncertain', detail: 'lost' },
      retry: 'Never resubmit this identity; missing observation means uncertain delivery.',
    },
  });

  expect(content.submissionReceipt).toEqual({
    id: 'reply-one',
    state: 'uncertain',
    detail: 'lost',
  });
  expect(JSON.stringify(content)).not.toContain('Private reply text.');
  expect(JSON.stringify(content)).not.toContain('Never resubmit');
});

it('builds reply content with and without a Pi question identity', () => {
  expect(
    modelReply('task-1', {
      questionId: 'question-1',
      replyAccepted: true,
      workerAcknowledged: false,
      delivery: 'sent',
    }),
  ).toEqual({
    taskId: 'task-1',
    questionId: 'question-1',
    replyAccepted: true,
    workerAcknowledged: false,
    delivery: 'sent',
  });
  expect(modelReply('task-1', { replyAccepted: true, delivery: 'notDelivered' })).toEqual({
    taskId: 'task-1',
    replyAccepted: true,
    delivery: 'notDelivered',
  });
});

it('builds the unreadable-evidence notice without state or outcome', () => {
  const content = modelEvidenceNotice({
    taskId: 'task-1',
    name: 'worker-ab',
    evidenceError: 'Invalid worker lifecycle record.',
    recovery: { paneId: 'pane-1', directory: '/abs/records/task-1' },
  });

  expect(Object.keys(content).toSorted()).toEqual(
    ['taskId', 'name', 'evidenceError', 'recovery'].toSorted(),
  );
  expect(content).not.toHaveProperty('state');
  expect(content).not.toHaveProperty('outcome');
});
