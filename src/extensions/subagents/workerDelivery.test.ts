import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { HcRuntime } from '../../hc/hc.js';
import { assignmentDirectory, writeAssignment } from './assignment.js';
import {
  createHc,
  createManager,
  deliverPending,
  liveTerminal,
  manager,
  managerSession,
  reportDelivery,
  savedAssignment,
  savedQuestion,
  savedReport,
  stubAgentDirectory,
} from './fixtures/workerDelivery.js';
import type { DeliveryContext, ManagerState } from './fixtures/workerDelivery.js';
import { createWorkerDelivery } from './workerDelivery.js';

const otherSession = '/sessions/previous.jsonl';

beforeEach(() => {
  vi.stubEnv('HC_TERMINAL_ID', manager);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it('notifies an error for a missing assignment file', async () => {
  const managerState = createManager();

  const hc = createHc([
    liveTerminal('t-child', manager, { 'tau.assignment': '/agent/missing.json' }),
  ]);

  await deliverPending(createWorkerDelivery(managerState.pi), hc, managerState.context);

  expect(managerState.notifications).toEqual([
    ['Missing assignment file: /agent/missing.json.', 'error'],
  ]);

  expect(managerState.messages).toEqual([]);
});

it('notifies an assignment read error once for repeated runs', async () => {
  const managerState = createManager();

  const hc = createHc([
    liveTerminal('t-child', manager, { 'tau.assignment': '/agent/missing.json' }),
  ]);

  const delivery = createWorkerDelivery(managerState.pi);

  await deliverPending(delivery, hc, managerState.context);
  await deliverPending(delivery, hc, managerState.context);

  expect(managerState.notifications).toEqual([
    ['Missing assignment file: /agent/missing.json.', 'error'],
  ]);
});

it('notifies an error for a malformed assignment file', async () => {
  const directory = stubAgentDirectory();
  const path = join(directory, 'assignment.json');

  writeFileSync(path, JSON.stringify({ version: 2, assignmentId: 'not-a-uuid' }));

  const managerState = createManager();
  const hc = createHc([liveTerminal('t-child', manager, { 'tau.assignment': path })]);

  await deliverPending(createWorkerDelivery(managerState.pi), hc, managerState.context);

  expect(managerState.notifications).toHaveLength(1);
  expect(managerState.notifications[0]?.[0]).toContain('Malformed assignment');
  expect(managerState.messages).toEqual([]);
});

it('skips a child without an assignment label', async () => {
  const managerState = createManager();
  const hc = createHc([liveTerminal('t-child', manager)]);

  await deliverPending(createWorkerDelivery(managerState.pi), hc, managerState.context);

  expect(managerState.notifications).toEqual([]);
  expect(managerState.messages).toEqual([]);
});

it('ignores an assignment whose report is not written yet', async () => {
  const directory = stubAgentDirectory();
  const saved = savedAssignment(directory, null);

  await writeAssignment(saved);

  const path = join(assignmentDirectory(saved.assignmentId), 'assignment.json');

  const managerState = createManager();
  const hc = createHc([liveTerminal('t-child', manager, { 'tau.assignment': path })]);

  await deliverPending(createWorkerDelivery(managerState.pi), hc, managerState.context);

  expect(managerState.notifications).toEqual([]);
  expect(managerState.messages).toEqual([]);
});

const finishedWorker = async (
  extraLabels: Record<string, string> = {},
): Promise<{
  managerState: ManagerState;
  hc: HcRuntime;
  assignmentId: string;
}> => {
  const directory = stubAgentDirectory();
  const saved = savedAssignment(directory, null);

  await writeAssignment(saved);

  const path = join(assignmentDirectory(saved.assignmentId), 'assignment.json');
  const managerState = createManager();

  const hc = createHc([
    {
      address: 't-child',
      state: 'finished',
      parent: manager,
      labels: { 'tau.assignment': path, ...extraLabels },
    },
  ]);

  return { managerState, hc, assignmentId: saved.assignmentId };
};

it('does not show a report from a worker of another manager session', async () => {
  const directory = stubAgentDirectory();
  const saved = { ...savedAssignment(directory, savedReport()), parentSession: otherSession };

  await writeAssignment(saved);

  const path = join(assignmentDirectory(saved.assignmentId), 'assignment.json');
  const managerState = createManager();
  const hc = createHc([liveTerminal('t-child', manager, { 'tau.assignment': path })]);

  await deliverPending(createWorkerDelivery(managerState.pi), hc, managerState.context);

  expect(managerState.messages).toEqual([]);
});

it('does not show an ended message for a worker of another manager session', async () => {
  const directory = stubAgentDirectory();
  const saved = { ...savedAssignment(directory, null), parentSession: otherSession };

  await writeAssignment(saved);

  const path = join(assignmentDirectory(saved.assignmentId), 'assignment.json');
  const managerState = createManager();

  const hc = createHc([
    { address: 't-child', state: 'finished', parent: manager, labels: { 'tau.assignment': path } },
  ]);

  await deliverPending(createWorkerDelivery(managerState.pi), hc, managerState.context);

  expect(managerState.messages).toEqual([]);
});

it('does not show a report when the manager session has no session file', async () => {
  const directory = stubAgentDirectory();
  const saved = savedAssignment(directory, savedReport());

  await writeAssignment(saved);

  const path = join(assignmentDirectory(saved.assignmentId), 'assignment.json');
  const managerState = createManager();

  const context = {
    ...managerState.context,
    sessionManager: { ...managerState.context.sessionManager, getSessionFile: () => undefined },
  } as unknown as DeliveryContext;

  const hc = createHc([liveTerminal('t-child', manager, { 'tau.assignment': path })]);

  await deliverPending(createWorkerDelivery(managerState.pi), hc, context);

  expect(managerState.messages).toEqual([]);
});

it('shows one ended message for a finished worker without a report', async () => {
  const { managerState, hc, assignmentId } = await finishedWorker();

  const delivery = createWorkerDelivery(managerState.pi);

  await deliverPending(delivery, hc, managerState.context);
  await deliverPending(delivery, hc, managerState.context);

  expect(managerState.messages).toHaveLength(1);

  const message = managerState.messages[0] as {
    customType: string;
    content: string;
    details: unknown;
  };

  expect(message.customType).toBe('tau-worker-ended');

  expect(message.content).toBe(
    `Worker ${assignmentId} at t-child ended without a report. Read its screen with hc read t-child.`,
  );

  expect(message.details).toEqual({ assignmentId });
});

it('restores the ended message from the saved session', async () => {
  const { managerState, hc, assignmentId } = await finishedWorker();

  managerState.entries.push({
    type: 'custom_message',
    customType: 'tau-worker-ended',
    details: { assignmentId },
  });

  await deliverPending(createWorkerDelivery(managerState.pi), hc, managerState.context);

  expect(managerState.messages).toEqual([]);
});

it('does not show an ended message twice while its message is still queued', async () => {
  const { managerState, hc } = await finishedWorker();

  managerState.setStreaming(true);

  const delivery = createWorkerDelivery(managerState.pi);

  await deliverPending(delivery, hc, managerState.context);
  await deliverPending(delivery, hc, managerState.context);

  expect(managerState.messages).toHaveLength(1);
});

it('does not show an ended message when the deadline message was shown', async () => {
  const { managerState, hc, assignmentId } = await finishedWorker();

  managerState.entries.push({
    type: 'custom_message',
    customType: 'tau-worker-deadline',
    details: { assignmentId },
  });

  await deliverPending(createWorkerDelivery(managerState.pi), hc, managerState.context);

  expect(managerState.messages).toEqual([]);
});

it('does not show the deadline message when the ended message was already shown', async () => {
  const { managerState, hc, assignmentId } = await finishedWorker();

  const delivery = createWorkerDelivery(managerState.pi);

  await deliverPending(delivery, hc, managerState.context);

  expect(managerState.messages).toHaveLength(1);

  delivery.showEnded(managerState.context, assignmentId, managerSession);

  expect(managerState.messages).toHaveLength(1);
  expect(managerState.messages[0]?.customType).toBe('tau-worker-ended');
});

it('shows the deadline message, not the ended message, for a worker that ended at its deadline', async () => {
  const { managerState, hc, assignmentId } = await finishedWorker({ 'tau.ended': 'deadline' });

  await deliverPending(createWorkerDelivery(managerState.pi), hc, managerState.context);

  expect(managerState.messages).toHaveLength(1);

  expect(managerState.messages[0]).toMatchObject({
    customType: 'tau-worker-deadline',
    details: { assignmentId },
  });
});

it('does not show the deadline message twice while it is still queued', async () => {
  const { managerState, hc } = await finishedWorker({ 'tau.ended': 'deadline' });

  managerState.setStreaming(true);

  const delivery = createWorkerDelivery(managerState.pi);

  await deliverPending(delivery, hc, managerState.context);
  await deliverPending(delivery, hc, managerState.context);

  expect(managerState.messages).toHaveLength(1);
});

it('shows the deadline message once when the launching session already showed it', async () => {
  const { managerState, hc, assignmentId } = await finishedWorker({ 'tau.ended': 'deadline' });

  const delivery = createWorkerDelivery(managerState.pi);

  delivery.showEnded(managerState.context, assignmentId, managerSession);
  await deliverPending(delivery, hc, managerState.context);

  expect(managerState.messages).toHaveLength(1);
  expect(managerState.messages[0]?.customType).toBe('tau-worker-deadline');
});

it('skips a terminal that is not the manager child', async () => {
  const managerState = createManager();

  const hc = createHc([
    liveTerminal('t-other', 't-elsewhere', { 'tau.assignment': '/agent/missing.json' }),
    liveTerminal('t-child', manager),
  ]);

  await deliverPending(createWorkerDelivery(managerState.pi), hc, managerState.context);

  expect(managerState.notifications).toEqual([]);
  expect(managerState.messages).toEqual([]);
});

it('keeps a queued report out of the saved session until its message is saved', async () => {
  const { managerState, deliver, assignmentId } = await reportDelivery();

  managerState.setStreaming(true);

  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);
  expect(managerState.entries).toEqual([]);

  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);
  expect(managerState.entries).toEqual([]);

  managerState.flush();

  expect(managerState.entries).toEqual([
    {
      type: 'custom_message',
      customType: 'tau-worker-report',
      details: { assignmentId, outcome: 'success' },
    },
  ]);

  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);
});

it('shows a new report once and records it as a report message', async () => {
  const { managerState, deliver, assignmentId } = await reportDelivery();

  managerState.entries.push(
    { type: 'custom_message', customType: 'other-extension', details: { assignmentId: 'other' } },
    { type: 'custom_message', customType: 'tau-worker-report', details: {} },
  );

  await deliver(managerState.context);
  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);

  expect(managerState.entries).toEqual([
    { type: 'custom_message', customType: 'other-extension', details: { assignmentId: 'other' } },
    { type: 'custom_message', customType: 'tau-worker-report', details: {} },
    {
      type: 'custom_message',
      customType: 'tau-worker-report',
      details: { assignmentId, outcome: 'success' },
    },
  ]);
});

it('restores the shown state from a saved report message for a fresh delivery', async () => {
  const { managerState, deliver, assignmentId } = await reportDelivery();

  managerState.entries.push({
    type: 'custom_message',
    customType: 'tau-worker-report',
    details: { assignmentId, outcome: 'success' },
  });

  await deliver(managerState.context);

  expect(managerState.messages).toEqual([]);
  expect(managerState.entries).toHaveLength(1);
});

it('wakes an idle manager with a report', async () => {
  const { managerState, deliver } = await reportDelivery();

  await deliver(managerState.context);

  expect(managerState.sendOptions).toEqual([{ triggerTurn: true }]);
});

it('steers a running manager with a report', async () => {
  const { managerState, deliver } = await reportDelivery(savedReport(), [], {
    idle: false,
    running: true,
  });

  await deliver(managerState.context);

  expect(managerState.sendOptions).toEqual([{ deliverAs: 'steer', triggerTurn: true }]);
});

it('shows non-empty report evidence in the message content', async () => {
  const { managerState, deliver } = await reportDelivery({
    outcome: 'success',
    summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
    evidence: ['a reference', 'another reference'],
  });

  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);

  const message = managerState.messages[0] as { content: string };

  expect(message.content).toContain('Evidence:\n- a reference\n- another reference');
});

it.each(['success', 'failure'] as const)(
  'shows the saved %s outcome in the report content and details',
  async (outcome) => {
    const { managerState, deliver, assignmentId } = await reportDelivery({
      outcome,
      summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
      evidence: [],
    });

    await deliver(managerState.context);

    expect(managerState.messages).toHaveLength(1);

    const message = managerState.messages[0] as { content: string; details: unknown };

    expect(message.content).toContain(`Worker report ${assignmentId}: ${outcome}`);
    expect(message.details).toEqual({ assignmentId, outcome });
  },
);

it('shows a pending question once and records it as a question message', async () => {
  const question = savedQuestion();
  const { managerState, deliver, assignmentId } = await reportDelivery(null, [question]);

  await deliver(managerState.context);
  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);

  expect(managerState.entries).toEqual([
    {
      type: 'custom_message',
      customType: 'tau-worker-question',
      details: { assignmentId, questionId: question.questionId },
    },
  ]);
});

it('shows a question again when another extension message carries its IDs', async () => {
  const question = savedQuestion();
  const { managerState, deliver, assignmentId } = await reportDelivery(null, [question]);

  managerState.entries.push({
    type: 'custom_message',
    customType: 'other-extension',
    details: { assignmentId, questionId: question.questionId },
  });

  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);
});

it('does not show a saved question again for a fresh delivery over its message', async () => {
  const question = savedQuestion();
  const { managerState, hc, assignmentId } = await reportDelivery(null, [question]);

  managerState.entries.push({
    type: 'custom_message',
    customType: 'tau-worker-question',
    details: { assignmentId, questionId: question.questionId },
  });

  await deliverPending(createWorkerDelivery(managerState.pi), hc, managerState.context);

  expect(managerState.messages).toEqual([]);
  expect(managerState.entries).toHaveLength(1);
});

it('does not show a queued question twice while its message is still queued', async () => {
  const { managerState, deliver } = await reportDelivery(null, [savedQuestion()]);

  managerState.setStreaming(true);

  await deliver(managerState.context);
  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);
});
