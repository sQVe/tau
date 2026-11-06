import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { executeAnswer } from '../src/extensions/subagents/answer.js';
import type { Assignment } from '../src/extensions/subagents/assignment.js';
import { readAssignment } from '../src/extensions/subagents/assignment.js';
import type { DeadlineWatchdog } from '../src/extensions/subagents/deadlineWatchdog.js';
import { registerWorkerScan } from '../src/extensions/subagents/subagents.js';
import { createWorkerDelivery } from '../src/extensions/subagents/workerDelivery.js';
import { createWorkerScan } from '../src/extensions/subagents/workerScan.js';
import type { WorkerScan } from '../src/extensions/subagents/workerScan.js';
import { get } from '../src/hc/hc.js';
import { startHcSession } from './hcSessionHarness.js';
import type { HcSession } from './hcSessionHarness.js';
import {
  launchWorkerSession,
  managerSessionFile,
  waitForReport,
} from './subagentSessionHarness.js';

interface SentMessage {
  customType?: unknown;
  content?: unknown;
  details?: unknown;
}

interface SessionEntry {
  type: string;
  customType?: string;
  content?: unknown;
  details?: unknown;
}

type DeliveryContext = Parameters<ReturnType<typeof createWorkerDelivery>['deliver']>[0];

interface RecordingExtension {
  pi: ExtensionAPI;
  handlers: Map<string, (event: unknown, context: unknown) => unknown>;
}

vi.mock(import('../src/extensions/subagents/loadout.js'), { spy: true });

vi.setConfig({ testTimeout: 120_000 });

const questionDeadlineMilliseconds = 90_000;
const questionPollMilliseconds = 100;

const waitForQuestion = async (path: string): Promise<Assignment> => {
  const deadline = Date.now() + questionDeadlineMilliseconds;

  let assignment = await readAssignment(path);

  while (assignment === undefined || assignment.questions.length === 0) {
    if (Date.now() > deadline) {
      throw new Error(`Worker never saved a question to ${path}.`);
    }

    await delay(questionPollMilliseconds);
    assignment = await readAssignment(path);
  }

  return assignment;
};

const managerQuestionProbe = `
import { appendFileSync } from 'node:fs';

const output = process.argv[2];

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  appendFileSync(output, JSON.stringify({ typed: chunk }) + '\\n');
});
`;

const waitForTerminalLabel = async (
  hc: HcSession,
  address: string,
  key: string,
  value: string,
): Promise<void> => {
  const deadline = Date.now() + questionDeadlineMilliseconds;

  for (;;) {
    const terminal = await get(hc.runtime, address);

    if (terminal.labels?.[key] === value) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(`Worker never set ${key} on ${address}.`);
    }

    await delay(questionPollMilliseconds);
  }
};

const sessionEntries = (assignment: Assignment): SessionEntry[] =>
  readFileSync(assignment.session.file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as SessionEntry);

const recordingExtension = (
  messages: SentMessage[],
  entries: SessionEntry[],
): RecordingExtension => {
  const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();

  const pi = {
    on: (eventName: string, handler: (event: unknown, context: unknown) => unknown) => {
      handlers.set(eventName, handler);
    },
    sendMessage: (message: SentMessage) => {
      messages.push(message);

      entries.push({
        type: 'custom_message',
        ...(typeof message.customType === 'string' ? { customType: message.customType } : {}),
        details: message.details,
      });
    },
  } as unknown as ExtensionAPI;

  return { pi, handlers };
};

const completionTracked = (scan: WorkerScan) => {
  let last: Promise<void> = Promise.resolve();

  return {
    scan: {
      scan: (context: DeliveryContext) => {
        last = scan.scan(context);

        return last;
      },
      clear: () => undefined,
    },
    settled: () => last,
  };
};

const noDeadline: DeadlineWatchdog = { apply: () => Promise.resolve(), clear: () => undefined };

const deliveryContext = (entries: SessionEntry[]): DeliveryContext =>
  ({
    sessionManager: { getEntries: () => entries, getSessionFile: () => managerSessionFile },
    ui: { notify: () => undefined },
    isIdle: () => true,
    signal: undefined,
  }) as unknown as DeliveryContext;

it('shows a real worker question once and carries the subagent_answer reply into its report', async () => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  vi.stubEnv('HC_SESSION', hc.session);

  vi.resetModules();

  const { fixtureModel, questionTaskMarker } =
    await import('../src/extensions/subagents/fixtures/controlledProvider.js');

  const worker = await launchWorkerSession({
    hc,
    model: fixtureModel,
    task: `${questionTaskMarker} Ask which value the report should hold.`,
    acceptance: ['Report the answer.'],
    probe: { source: managerQuestionProbe },
    inbox: true,
  });

  const assignment = await waitForQuestion(worker.assignmentFilePath);

  if (worker.observationPath === undefined) {
    throw new Error('The fixture worker got no manager probe.');
  }

  const question = assignment.questions[0];

  if (question === undefined) {
    throw new Error('Worker saved no question.');
  }

  await waitForTerminalLabel(hc, worker.workerAddress, 'tau.question', question.questionId);

  const messages: SentMessage[] = [];
  const entries: SessionEntry[] = [];
  const { pi, handlers } = recordingExtension(messages, entries);
  const context = deliveryContext(entries);

  const tracked = completionTracked(
    createWorkerScan(hc.runtime, createWorkerDelivery(pi), noDeadline),
  );

  registerWorkerScan(pi, tracked.scan, { start: () => undefined, stop: () => undefined });

  const compact = handlers.get('session_compact');

  if (compact === undefined) {
    throw new Error('worker delivery handlers are not registered');
  }

  compact({}, context);
  compact({}, context);

  await tracked.settled();

  expect(messages).toHaveLength(1);

  compact({}, context);

  await tracked.settled();

  expect(messages).toHaveLength(1);

  const questionMessage = messages[0];

  expect(questionMessage?.content).toContain(question.text);

  expect(questionMessage?.details).toEqual({
    assignmentId: assignment.assignmentId,
    questionId: question.questionId,
  });

  expect(questionMessage?.content).toContain(question.questionId);

  const reply = `manager-reply-${randomBytes(6).toString('hex')}`;

  const answered = await executeAnswer(hc.runtime, {
    parameters: {
      assignmentId: assignment.assignmentId,
      questionId: question.questionId,
      answer: reply,
    },
    parentSession: assignment.parentSession,
  });

  expect(answered.details).toMatchObject({ status: 'queued', messageId: question.questionId });

  const reported = await waitForReport(worker.assignmentFilePath);

  expect(reported.report?.evidence).toContain(reply);

  const answerEntry = sessionEntries(reported).find(
    (entry) => entry.type === 'custom_message' && entry.customType === 'tau-inbox-message',
  );

  expect(answerEntry?.content).toBe(reply);
  expect(answerEntry?.details).toMatchObject({ family: 'answer', questionId: question.questionId });

  await delay(500);

  expect(existsSync(worker.observationPath)).toBe(false);
});

it('shows a question once across repeated delivery scans', async () => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  vi.stubEnv('HC_SESSION', hc.session);

  vi.resetModules();

  const { fixtureModel, questionTaskMarker } =
    await import('../src/extensions/subagents/fixtures/controlledProvider.js');

  const worker = await launchWorkerSession({
    hc,
    model: fixtureModel,
    task: `${questionTaskMarker} Ask which value the report should hold.`,
    acceptance: ['Report the answer.'],
  });

  const assignment = await waitForQuestion(worker.assignmentFilePath);
  const question = assignment.questions[0];

  if (question === undefined) {
    throw new Error('Worker saved no question.');
  }

  await waitForTerminalLabel(hc, worker.workerAddress, 'tau.question', question.questionId);

  const messages: SentMessage[] = [];
  const entries: SessionEntry[] = [];
  const { pi } = recordingExtension(messages, entries);
  const context = deliveryContext(entries);

  await createWorkerScan(hc.runtime, createWorkerDelivery(pi), noDeadline).scan(context);

  expect(messages).toHaveLength(1);

  expect(messages[0]?.details).toEqual({
    assignmentId: assignment.assignmentId,
    questionId: question.questionId,
  });

  await createWorkerScan(hc.runtime, createWorkerDelivery(pi), noDeadline).scan(context);

  expect(messages).toHaveLength(1);
});
