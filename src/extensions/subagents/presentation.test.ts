import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { modelEvidenceNotice, modelReply, modelStatus, stateLabel } from './presentation.js';
import { acceptReport, readReport } from './records.js';
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
const fullStatus = (state: WorkerState) => ({
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
  usage: { available: false, reason: 'Pi reports worker usage in its own session totals.' },
  directory: '/abs/records/task-1',
  nativeSessionId: 'native-1',
  nativeSessionFile: '/abs/records/task-1/session.jsonl',
});

const expectKeys = (state: WorkerState) => {
  const content = modelStatus(fullStatus(state));
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
  ];

  if (cleanup) {
    expected.push('recovery');
  }

  return { content, expected };
};

const stringValues = (value: unknown, at: string[] = []): { path: string; text: string }[] => {
  if (typeof value === 'string') {
    return [{ path: at.join('.'), text: value }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => stringValues(entry, [...at, String(index)]));
  }

  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => stringValues(entry, [...at, key]));
  }

  return [];
};

it.each(states)('builds the allowlisted model content for %s', (state) => {
  const { content, expected } = expectKeys(state);
  expect(Object.keys(content).toSorted()).toEqual(expected.toSorted());
  expect(content.taskId).toBe('task-1');
  expect(content.state).toBe(state);
  expect(content.predecessorTaskId).toBe('predecessor-1');
  expect(content.successorTaskId).toBe('successor-1');
});

it('keeps recovery only for unconfirmed or unowned states', () => {
  for (const state of states) {
    const content = modelStatus(fullStatus(state));
    const cleanup = cleanupStates.has(state);

    expect('recovery' in content).toBe(cleanup);
  }
});

it('never leaks an absolute path outside recovery and report text', () => {
  for (const state of states) {
    const content = modelStatus(fullStatus(state));

    const values = stringValues(content).filter(
      ({ path }) => !path.startsWith('recovery') && !path.startsWith('report'),
    );

    for (const { path, text } of values) {
      expect(text.startsWith('/'), `${path} leaked a path`).toBe(false);
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

const activity = {
  taskId: 'task-1',
  sequence: 3,
  updatedAt: 5,
  phase: 'active' as const,
  label: 'tool: read',
  description: 'Fixing status counts',
  model: 'provider/model',
  usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
};

it.each([
  ['starting', true],
  ['running', true],
  ['awaitingReply', true],
  ['notOwned', true],
  ['reported', false],
  ['stopping', false],
  ['stopped', false],
  ['cleanupUnconfirmed', false],
] as const)('shows worker activity for %s: %s', (state, shown) => {
  const content = modelStatus({ taskId: 'task-1', state, deadline: 10, activity });

  expect(content.activity).toEqual(
    shown
      ? {
          phase: 'active',
          description: 'Fixing status counts',
          updatedAt: 5,
          usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        }
      : undefined,
  );
});

it('shows only the phase and time of activity without a description or usage', () => {
  const content = modelStatus({
    taskId: 'task-1',
    state: 'running',
    deadline: 10,
    activity: { taskId: 'task-1', sequence: 0, updatedAt: 5, phase: 'starting' },
  });

  expect(content.activity).toEqual({ phase: 'starting', updatedAt: 5 });
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

it('counts parenthesized and quoted headings that the report tool accepts', () => {
  const status = modelStatus({
    taskId: 'task-1',
    state: 'stopped',
    deadline: 10,
    outcome: 'success',
    report: {
      taskId: 'task-1',
      outcome: 'success',
      summary: '## Changes\nNone\n> Evidence: none\nDECISIONS: None\n### Concerns (open)\nNone',
      evidence: [],
    },
  });

  expect(status.handoffSections).toEqual({
    present: ['Changes', 'Evidence', 'Decisions', 'Concerns'],
    missing: [],
  });
});

it('caps a long report and points to the unchanged saved report', ({ onTestFinished }) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-presentation-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  acceptReport(directory, 'task-1', {
    taskId: 'task-1',
    outcome: 'success',
    summary: `## Changes\n${'s'.repeat(6000)}`,
    evidence: ['e'.repeat(3000), 'kept-out'],
  });

  const saved = readFileSync(join(directory, 'report.json'), 'utf8');
  const report = readReport(directory, 'task-1');
  const status = { taskId: 'task-1', state: 'stopped' as const, deadline: 10, directory, report };
  const content = modelStatus(status);

  expect(content.report).toEqual({
    taskId: 'task-1',
    outcome: 'success',
    summary: report?.summary,
    evidence: ['e'.repeat(8000 - (report?.summary.length ?? 0))],
  });

  expect(content.truncated).toBe(true);
  expect(readFileSync(content.reportFile as string, 'utf8')).toBe(saved);
  expect(status.report).toEqual(JSON.parse(saved));

  expect(content.handoffSections).toEqual({
    present: ['Changes'],
    missing: ['Evidence', 'Decisions', 'Concerns'],
  });
});

it('passes a report within the cap through without a cut mark', () => {
  const report = { taskId: 'task-1', outcome: 'success', summary: 'Done.', evidence: ['e'] };

  const content = modelStatus({ taskId: 'task-1', state: 'stopped', deadline: 10, report });

  expect(content.report).toEqual(report);
  expect(content).not.toHaveProperty('truncated');
  expect(content).not.toHaveProperty('reportFile');
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

it('builds reply content with the question identity', () => {
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

it('labels a stopped worker with an inherited-key outcome as plain stopped', () => {
  expect(stateLabel('stopped', 'constructor')).toEqual(stateLabel('stopped'));
  expect(stateLabel('stopped', 'success').icon).toBe('✓');
});
