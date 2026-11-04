import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { Exec } from '../../command.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { assignmentDirectory, writeAssignment } from './assignment.js';
import type { Assignment, SavedQuestion } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { createWorkerDelivery, readWorkerChildren } from './workerDelivery.js';
import type { WorkerDelivery } from './workerDelivery.js';

type DeliveryContext = Parameters<ReturnType<typeof createWorkerDelivery>['deliver']>[0];

interface SentMessage {
  customType?: unknown;
  details?: unknown;
}

interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
}

const manager = 't-manager';

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

const customMessageEntry = (message: SentMessage): SessionEntryLike => ({
  type: 'custom_message',
  ...(typeof message.customType === 'string' ? { customType: message.customType } : {}),
  details: message.details,
});

const createManager = (options: { idle?: boolean; running?: boolean } = {}) => {
  const messages: SentMessage[] = [];
  const sendOptions: unknown[] = [];
  const entries: SessionEntryLike[] = [];
  const queued: SentMessage[] = [];
  const notifications: [string, string | undefined][] = [];
  let streaming = false;

  const pi = {
    on: () => undefined,
    sendMessage: (message: SentMessage, sendOption?: unknown) => {
      messages.push(message);
      sendOptions.push(sendOption);

      if (streaming) {
        queued.push(message);
      } else {
        entries.push(customMessageEntry(message));
      }
    },
  } as unknown as ExtensionAPI;

  const context = {
    sessionManager: { getEntries: () => entries },
    ui: {
      notify: (message: string, kind: string | undefined) => notifications.push([message, kind]),
    },
    isIdle: () => options.idle ?? true,
    signal: options.running === true ? new AbortController().signal : undefined,
  } as unknown as DeliveryContext;

  return {
    pi,
    context,
    messages,
    sendOptions,
    entries,
    notifications,
    setStreaming: (value: boolean) => {
      streaming = value;
    },
    flush: () => {
      for (const message of queued.splice(0)) {
        entries.push(customMessageEntry(message));
      }
    },
  };
};

const savedAssignment = (
  directory: string,
  report: Assignment['report'],
  questions: SavedQuestion[] = [],
): Assignment => {
  const assignmentId = randomUUID();
  const sessionId = randomUUID();

  return {
    version: 3,
    assignmentId,
    task: 'Inspect the counters.',
    acceptance: [],
    label: null,
    profile: 'worker',
    loadout: fixtureLoadout(directory),
    routing: null,
    packageSnapshot: null,
    session: { id: sessionId, file: join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`) },
    parentSession: join(directory, 'parent.jsonl'),
    cwd: directory,
    parentTerminal: manager,
    deadline: Date.now() + 30_000,
    createdAt: Date.now(),
    previousAssignmentId: null,
    extensionPackages: null,
    questions,
    report,
  };
};

const stubAgentDirectory = (): string => {
  const directory = temporaryDirectory(onTestFinished, 'tau-delivery-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  return directory;
};

const savedReport = (): Assignment['report'] => ({
  outcome: 'success',
  summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
  evidence: ['a reference'],
});

const savedQuestion = (): SavedQuestion => ({
  questionId: randomUUID(),
  text: 'Which branch should I use?',
  askedAt: Date.now(),
});

const deliverPending = async (
  delivery: WorkerDelivery,
  hc: HcRuntime,
  context: DeliveryContext,
): Promise<void> => {
  delivery.deliver(context, await readWorkerChildren(hc, manager));
};

const reportDelivery = async (
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
  const delivery = createWorkerDelivery(managerState.pi);

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

const finishedWorker = async (): Promise<{
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
    { address: 't-child', state: 'finished', parent: manager, labels: { 'tau.assignment': path } },
  ]);

  return { managerState, hc, assignmentId: saved.assignmentId };
};

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

  delivery.showEnded(managerState.context, assignmentId);

  expect(managerState.messages).toHaveLength(1);
  expect(managerState.messages[0]?.customType).toBe('tau-worker-ended');
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

it('names the worker address and the hc send answer in the question message', async () => {
  const { managerState, deliver } = await reportDelivery(null, [savedQuestion()]);

  await deliver(managerState.context);

  const message = managerState.messages[0] as { content: string };

  expect(message.content).toContain('Which branch should I use?');
  expect(message.content).toContain('hc send t-child "<answer>"');
});
