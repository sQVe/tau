import { expect, it } from 'vitest';

import { modelEvidenceNotice, modelReply, modelStatus, stateLabel } from './presentation.js';
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
    'handoffSections',
    'pendingQuestion',
    'failure',
    'cleanup',
    'questionReceipt',
    'submissionReceipt',
    'nativeOutput',
    'observationIssue',
    ...(generic ? ['nativeState'] : []),
    'unconfirmedChildren',
    'descendantEvidence',
    ...(cleanup ? ['recovery', 'capacityHeld'] : []),
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

    for (const key of ['recovery', 'capacityHeld']) {
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

it('marks handoff sections present and missing without inventing evidence', () => {
  const legacy = modelStatus({
    taskId: 'task-1',
    state: 'stopped',
    deadline: 10,
    outcome: 'success',
    report: {
      taskId: 'task-1',
      outcome: 'success',
      summary: 'Finished the fixture.',
      evidence: ['/abs/run.json'],
    },
  });

  expect(legacy.handoffSections).toEqual({
    present: [],
    missing: ['Changes', 'Evidence', 'Decisions', 'Concerns'],
  });

  const complete = modelStatus({
    taskId: 'task-1',
    state: 'stopped',
    deadline: 10,
    outcome: 'success',
    report: {
      taskId: 'task-1',
      outcome: 'success',
      summary:
        'Changes: edited value.ts\nEvidence: pnpm check passed\nDecisions: none\nConcerns: none',
      evidence: ['/abs/run.json'],
    },
  });

  expect(complete.handoffSections).toEqual({
    present: ['Changes', 'Evidence', 'Decisions', 'Concerns'],
    missing: [],
  });

  const withoutReport = modelStatus({ taskId: 'task-1', state: 'running', deadline: 10 });
  expect(withoutReport).not.toHaveProperty('handoffSections');
});

it('counts only real handoff headings, including a generic report without an Evidence section', () => {
  const prose = modelStatus({
    taskId: 'task-1',
    state: 'stopped',
    deadline: 10,
    outcome: 'success',
    report: {
      taskId: 'task-1',
      outcome: 'success',
      summary: 'Changes to policy are out of scope.',
      evidence: ['/saved/report.md'],
    },
  });

  expect(prose.handoffSections).toEqual({
    present: [],
    missing: ['Changes', 'Evidence', 'Decisions', 'Concerns'],
  });

  const genericWithoutEvidence = modelStatus({
    taskId: 'task-1',
    state: 'stopped',
    deadline: 10,
    outcome: 'incomplete',
    report: {
      taskId: 'task-1',
      outcome: 'incomplete',
      summary: '## Changes\nEdited value.ts.\n**Decisions**: none.\n- Concerns: none.',
      evidence: ['/saved/report.md'],
    },
  });

  expect(genericWithoutEvidence.handoffSections).toEqual({
    present: ['Changes', 'Decisions', 'Concerns'],
    missing: ['Evidence'],
  });
});

it('carries a bounded native observation reason into model content', () => {
  const short = modelStatus({
    taskId: 'task-1',
    state: 'running',
    deadline: 10,
    observationIssue: 'herdr observation failed.',
  });
  expect(short.observationIssue).toBe('herdr observation failed.');

  const long = modelStatus({
    taskId: 'task-1',
    state: 'running',
    deadline: 10,
    observationIssue: '界'.repeat(1000),
  });
  const reason = String(long.observationIssue);
  expect(reason.length).toBeLessThan(1000);
  expect(reason.startsWith('界'.repeat(200))).toBe(true);
});

it('carries a saved-reply flag on a pending question', () => {
  const content = modelStatus({
    taskId: 'task-1',
    state: 'awaitingReply',
    deadline: 10,
    pendingQuestion: { questionId: 'question-1', question: 'Which file?', replySaved: true },
  });

  expect(content.pendingQuestion).toEqual({
    questionId: 'question-1',
    question: 'Which file?',
    replySaved: true,
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

it('keeps unconfirmed descendants for the model even when the parent stopped', () => {
  const content = modelStatus({
    ...fullStatus('stopped', false),
    unconfirmedChildren: [{ taskId: 'child-1', directory: '/records/child-1' }],
    descendantEvidence: 'Descendant reservation evidence unavailable.',
  });

  expect(content).toMatchObject({
    unconfirmedChildren: [{ taskId: 'child-1' }],
    descendantEvidence: 'Descendant reservation evidence unavailable.',
  });
  expect(JSON.stringify(content)).not.toContain('/records/child-1');
});

it('labels a stopped worker with an inherited-key outcome as plain stopped', () => {
  expect(stateLabel('stopped', 'constructor')).toEqual(stateLabel('stopped'));
  expect(stateLabel('stopped', 'success').icon).toBe('✓');
});
