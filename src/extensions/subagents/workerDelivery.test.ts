import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import {
  createManager,
  manager,
  managerSession,
  otherSession,
  savedAssignment,
  savedQuestion,
  savedReport,
} from '../../../tests/deliveryManager.js';
import type { DeliveryContext } from '../../../tests/deliveryManager.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { Exec } from '../../command.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { assignmentDirectory, assignmentPath, writeAssignment } from './assignment.js';
import type { Assignment, SavedQuestion } from './assignment.js';
import { createWorkerDelivery, readWorkerChildren } from './workerDelivery.js';
import type { ReportSuffix, WorkerDelivery } from './workerDelivery.js';

const noSuffix: ReportSuffix = () => '';
const planSuffixText = '\n\nCurrent plan:\n[in_progress] Step';
const nonEmptySuffix: ReportSuffix = () => planSuffixText;

beforeEach(() => {
  vi.stubEnv('HC_TERMINAL_ID', manager);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const liveTerminal = (
  address: string,
  parent: string,
  labels?: Record<string, string>,
): HcTerminal => ({
  address,
  state: 'live',
  parent,
  ...(labels === undefined ? {} : { labels }),
});

const succeeded = (value: unknown) => ({
  code: 0,
  killed: false,
  truncated: false,
  stdout: JSON.stringify(value),
  stderr: '',
});

// `ls` rows carry no labels, so every label read goes through `get`.
const createHc = (terminals: HcTerminal[]): HcRuntime => {
  const exec: Exec = (command, commandArguments) => {
    if (command !== 'hc') {
      return Promise.resolve({
        code: 1,
        killed: false,
        truncated: false,
        stdout: '',
        stderr: 'unexpected',
      });
    }

    if (commandArguments[0] === 'ls') {
      return Promise.resolve(
        succeeded({
          terminals: terminals.map((terminal) => ({ ...terminal, labels: undefined })),
        }),
      );
    }

    if (commandArguments[0] === 'get') {
      const address = commandArguments.at(-1);
      const terminal = terminals.find((candidate) => candidate.address === address);

      return terminal === undefined
        ? Promise.resolve({
            code: 1,
            killed: false,
            truncated: false,
            stdout: '',
            stderr: 'not_found',
          })
        : Promise.resolve(succeeded(terminal));
    }

    return Promise.resolve({
      code: 1,
      killed: false,
      truncated: false,
      stdout: '',
      stderr: 'unexpected',
    });
  };

  return { exec, connect: () => Promise.reject(new Error('not used')), cwd: process.cwd() };
};

const stubAgentDirectory = (): string => {
  const directory = temporaryDirectory(onTestFinished, 'tau-delivery-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  return directory;
};

const deliverPending = async (
  delivery: WorkerDelivery,
  hc: HcRuntime,
  context: DeliveryContext,
): Promise<void> => {
  delivery.deliver(context, await readWorkerChildren(hc, manager));
};

const reportDelivery = async (
  suffix: ReportSuffix,
  report: Assignment['report'] = savedReport(),
  questions: SavedQuestion[] = [],
  managerOptions: { idle?: boolean; running?: boolean } = {},
): Promise<{
  managerState: ReturnType<typeof createManager>;
  deliver: (context: DeliveryContext) => Promise<void>;
  hc: HcRuntime;
  assignmentId: string;
}> => {
  const directory = stubAgentDirectory();
  const saved = savedAssignment(directory, report, questions);

  await writeAssignment(saved);

  const path = join(assignmentDirectory(saved.assignmentId), 'assignment.json');
  const managerState = createManager(managerOptions);
  const hc = createHc([liveTerminal('t-child', manager, { 'tau.assignment': path })]);
  const delivery = createWorkerDelivery(managerState.pi, suffix);

  return {
    managerState,
    deliver: (context) => deliverPending(delivery, hc, context),
    hc,
    assignmentId: saved.assignmentId,
  };
};

it('notifies an error for a missing assignment file', async () => {
  const managerState = createManager();

  const hc = createHc([
    liveTerminal('t-child', manager, { 'tau.assignment': '/agent/missing.json' }),
  ]);

  await deliverPending(createWorkerDelivery(managerState.pi, noSuffix), hc, managerState.context);

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

  const delivery = createWorkerDelivery(managerState.pi, noSuffix);

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

  await deliverPending(createWorkerDelivery(managerState.pi, noSuffix), hc, managerState.context);

  expect(managerState.notifications).toHaveLength(1);
  expect(managerState.notifications[0]?.[0]).toContain('Malformed assignment');
  expect(managerState.messages).toEqual([]);
});

it('skips a child without an assignment label', async () => {
  const managerState = createManager();
  const hc = createHc([liveTerminal('t-child', manager)]);

  await deliverPending(createWorkerDelivery(managerState.pi, noSuffix), hc, managerState.context);

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

  await deliverPending(createWorkerDelivery(managerState.pi, noSuffix), hc, managerState.context);

  expect(managerState.notifications).toEqual([]);
  expect(managerState.messages).toEqual([]);
});

const finishedWorker = async (
  extraLabels: Record<string, string> = {},
): Promise<{
  managerState: ReturnType<typeof createManager>;
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

  await deliverPending(createWorkerDelivery(managerState.pi, noSuffix), hc, managerState.context);

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

  await deliverPending(createWorkerDelivery(managerState.pi, noSuffix), hc, managerState.context);

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

  await deliverPending(createWorkerDelivery(managerState.pi, noSuffix), hc, context);

  expect(managerState.messages).toEqual([]);
});

it('shows one ended message for a finished worker without a report', async () => {
  const { managerState, hc, assignmentId } = await finishedWorker();

  const delivery = createWorkerDelivery(managerState.pi, noSuffix);

  await deliverPending(delivery, hc, managerState.context);
  await deliverPending(delivery, hc, managerState.context);

  expect(managerState.messages).toHaveLength(1);

  const message = managerState.messages[0] as {
    customType: string;
    content: string;
    details: unknown;
  };

  expect(message.customType).toBe('tau-worker-ended');

  expect(message.content).toContain(assignmentId);

  expect(message.content).toContain('hc read t-child');

  expect(message.details).toEqual({ assignmentId });
});

it('restores the ended message from the saved session', async () => {
  const { managerState, hc, assignmentId } = await finishedWorker();

  managerState.entries.push({
    type: 'custom_message',
    customType: 'tau-worker-ended',
    details: { assignmentId },
  });

  await deliverPending(createWorkerDelivery(managerState.pi, noSuffix), hc, managerState.context);

  expect(managerState.messages).toEqual([]);
});

it('does not show an ended message twice while its message is still queued', async () => {
  const { managerState, hc } = await finishedWorker();

  managerState.setStreaming(true);

  const delivery = createWorkerDelivery(managerState.pi, noSuffix);

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

  await deliverPending(createWorkerDelivery(managerState.pi, noSuffix), hc, managerState.context);

  expect(managerState.messages).toEqual([]);
});

it('does not show the deadline message when the ended message was already shown', async () => {
  const { managerState, hc, assignmentId } = await finishedWorker();

  const delivery = createWorkerDelivery(managerState.pi, noSuffix);

  await deliverPending(delivery, hc, managerState.context);

  expect(managerState.messages).toHaveLength(1);

  delivery.showEnded(managerState.context, {
    assignmentId,
    address: 't-child',
    parentSession: managerSession,
  });

  expect(managerState.messages).toHaveLength(1);
  expect(managerState.messages[0]?.customType).toBe('tau-worker-ended');
});

it('shows the deadline message, not the ended message, for a worker that ended at its deadline', async () => {
  const { managerState, hc, assignmentId } = await finishedWorker({ 'tau.ended': 'deadline' });

  await deliverPending(createWorkerDelivery(managerState.pi, noSuffix), hc, managerState.context);

  expect(managerState.messages).toHaveLength(1);

  expect(managerState.messages[0]).toMatchObject({
    customType: 'tau-worker-deadline',
    details: { assignmentId },
  });
});

it('does not show the deadline message twice while it is still queued', async () => {
  const { managerState, hc } = await finishedWorker({ 'tau.ended': 'deadline' });

  managerState.setStreaming(true);

  const delivery = createWorkerDelivery(managerState.pi, noSuffix);

  await deliverPending(delivery, hc, managerState.context);
  await deliverPending(delivery, hc, managerState.context);

  expect(managerState.messages).toHaveLength(1);
});

it('shows the deadline message once when the launching session already showed it', async () => {
  const { managerState, hc, assignmentId } = await finishedWorker({ 'tau.ended': 'deadline' });

  const delivery = createWorkerDelivery(managerState.pi, noSuffix);

  delivery.showEnded(managerState.context, {
    assignmentId,
    address: 't-child',
    parentSession: managerSession,
  });

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

  await deliverPending(createWorkerDelivery(managerState.pi, noSuffix), hc, managerState.context);

  expect(managerState.notifications).toEqual([]);
  expect(managerState.messages).toEqual([]);
});

it('keeps a queued report out of the saved session until its message is saved', async () => {
  const { managerState, deliver, assignmentId } = await reportDelivery(noSuffix);

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
  const { managerState, deliver, assignmentId } = await reportDelivery(noSuffix);

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
  const { managerState, deliver, assignmentId } = await reportDelivery(noSuffix);

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
  const { managerState, deliver } = await reportDelivery(noSuffix);

  await deliver(managerState.context);

  expect(managerState.sendOptions).toEqual([{ triggerTurn: true }]);
});

it('steers a running manager with a report', async () => {
  const { managerState, deliver } = await reportDelivery(noSuffix, savedReport(), [], {
    idle: false,
    running: true,
  });

  await deliver(managerState.context);

  expect(managerState.sendOptions).toEqual([{ deliverAs: 'steer', triggerTurn: true }]);
});

it('shows non-empty report evidence in the message content', async () => {
  const { managerState, deliver } = await reportDelivery(noSuffix, {
    outcome: 'success',
    summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
    evidence: ['a reference', 'another reference'],
  });

  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);

  const message = managerState.messages[0] as { content: string };

  expect(message.content).toContain('Evidence:\n- a reference\n- another reference');
});

it('names the deferred full check owner and the cited record result', async () => {
  const logPath = '/repository/.tau/checks/run.log';

  const { managerState, deliver } = await reportDelivery(noSuffix, {
    outcome: 'success',
    summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
    evidence: [logPath],
    fullCheck: { owner: 'AI-1688', logPath, passed: false },
  });

  await deliver(managerState.context);

  const message = managerState.messages[0] as { content: string };

  expect(message.content).toContain('Full check: deferred to AI-1688; the cited record failed.');
  expect(message.content).toContain(`Log: ${logPath}`);
});

it.each(['success', 'failure'] as const)(
  'shows the saved %s outcome in the report content and details',
  async (outcome) => {
    const { managerState, deliver, assignmentId } = await reportDelivery(noSuffix, {
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

it('appends the plan suffix to a report for a lead with a plan', async () => {
  const branchEntry = { type: 'custom', customType: 'tau-plan', data: { version: 1, steps: [] } };

  const siblingEntry = {
    type: 'custom',
    customType: 'tau-plan',
    data: { version: 1, steps: [{ text: 'Sibling step', status: 'pending' }] },
  };

  const received: (readonly unknown[])[] = [];

  const suffix: ReportSuffix = (entries) => {
    received.push(entries);

    return planSuffixText;
  };

  const { managerState, deliver } = await reportDelivery(suffix);

  managerState.entries.push(siblingEntry);
  managerState.branchEntries.push(branchEntry);

  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);

  const message = managerState.messages[0] as { content: string };

  expect(message.content.endsWith(planSuffixText)).toBe(true);
  expect(received).toEqual([[branchEntry]]);
});

it('leaves a report unchanged for a lead without a plan', async () => {
  const { managerState, deliver, assignmentId } = await reportDelivery(noSuffix);

  await deliver(managerState.context);

  const message = managerState.messages[0] as { content: string };
  const expected = `Worker report ${assignmentId}: success\n\nChanges: None\nEvidence: None\nDecisions: None\nConcerns: None\n\nEvidence:\n- a reference`;

  expect(message.content).toBe(expected);
});

it('does not add the suffix to a question message', async () => {
  const question = savedQuestion();

  const { managerState, deliver, assignmentId } = await reportDelivery(nonEmptySuffix, null, [
    question,
  ]);

  await deliver(managerState.context);

  const message = managerState.messages[0] as { content: string };
  const expected = `Worker question ${assignmentId} from t-child:\n\n${question.text}\n\nAnswer with \`subagent_answer\` for assignment ${assignmentId}, question ${question.questionId}. If it refuses the answer, report that to the user.`;

  expect(message.content).toBe(expected);
});

it('does not add the suffix to an ended message', async () => {
  const { managerState, hc, assignmentId } = await finishedWorker();

  await deliverPending(
    createWorkerDelivery(managerState.pi, nonEmptySuffix),
    hc,
    managerState.context,
  );

  const message = managerState.messages[0] as { content: string };

  expect(message.content).toBe(
    `Worker ${assignmentId} at t-child ended without a report. Read its screen with hc read t-child.`,
  );
});

it('does not add the suffix to a deadline message', async () => {
  const { managerState, hc, assignmentId } = await finishedWorker({ 'tau.ended': 'deadline' });

  await deliverPending(
    createWorkerDelivery(managerState.pi, nonEmptySuffix),
    hc,
    managerState.context,
  );

  const message = managerState.messages[0] as { content: string };

  expect(message.content).toBe(`Worker ${assignmentId} was ended at its deadline.`);
});

it('reads no branch entries for a scan that holds no report', async () => {
  const directory = stubAgentDirectory();
  const questionAssignment = savedAssignment(directory, null, [savedQuestion()]);
  const endedAssignment = savedAssignment(directory, null);
  const deadlineAssignment = savedAssignment(directory, null);

  await writeAssignment(questionAssignment);
  await writeAssignment(endedAssignment);
  await writeAssignment(deadlineAssignment);

  const managerState = createManager();

  const hc = createHc([
    liveTerminal('t-question', manager, {
      'tau.assignment': assignmentPath(questionAssignment.assignmentId),
    }),
    {
      address: 't-ended',
      state: 'finished',
      parent: manager,
      labels: { 'tau.assignment': assignmentPath(endedAssignment.assignmentId) },
    },
    {
      address: 't-deadline',
      state: 'finished',
      parent: manager,
      labels: {
        'tau.assignment': assignmentPath(deadlineAssignment.assignmentId),
        'tau.ended': 'deadline',
      },
    },
  ]);

  await deliverPending(
    createWorkerDelivery(managerState.pi, nonEmptySuffix),
    hc,
    managerState.context,
  );

  expect(managerState.messages.map((message) => message.customType)).toEqual([
    'tau-worker-question',
    'tau-worker-ended',
    'tau-worker-deadline',
  ]);

  expect(managerState.branchReads).toEqual([]);
});

it('shows a pending question once and records it as a question message', async () => {
  const question = savedQuestion();
  const { managerState, deliver, assignmentId } = await reportDelivery(noSuffix, null, [question]);

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
  const { managerState, deliver, assignmentId } = await reportDelivery(noSuffix, null, [question]);

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
  const { managerState, hc, assignmentId } = await reportDelivery(noSuffix, null, [question]);

  managerState.entries.push({
    type: 'custom_message',
    customType: 'tau-worker-question',
    details: { assignmentId, questionId: question.questionId },
  });

  await deliverPending(createWorkerDelivery(managerState.pi, noSuffix), hc, managerState.context);

  expect(managerState.messages).toEqual([]);
  expect(managerState.entries).toHaveLength(1);
});

it('does not show a queued question twice while its message is still queued', async () => {
  const { managerState, deliver } = await reportDelivery(noSuffix, null, [savedQuestion()]);

  managerState.setStreaming(true);

  await deliver(managerState.context);
  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);
});

it('names the assignment and question IDs the answer needs in the question message', async () => {
  const question = savedQuestion();
  const { managerState, deliver, assignmentId } = await reportDelivery(noSuffix, null, [question]);

  await deliver(managerState.context);

  const message = managerState.messages[0] as { content: string };

  expect(message.content).toContain('Which branch should I use?');
  expect(message.content).toContain(assignmentId);
  expect(message.content).toContain(question.questionId);
});
