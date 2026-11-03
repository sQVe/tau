import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import type { Assignment } from '../src/extensions/subagents/assignment.js';
import { readAssignment } from '../src/extensions/subagents/assignment.js';
import type { DeadlineWatchdog } from '../src/extensions/subagents/deadlineWatchdog.js';
import { registerWorkerScan } from '../src/extensions/subagents/subagents.js';
import { createWorkerDelivery } from '../src/extensions/subagents/workerDelivery.js';
import { createWorkerScan } from '../src/extensions/subagents/workerScan.js';
import type { WorkerScan } from '../src/extensions/subagents/workerScan.js';
import { ls, send } from '../src/hc/hc.js';
import { installCommandShim } from './commandShimFake.js';
import { startHcSession } from './hcSessionHarness.js';
import type { HcSession } from './hcSessionHarness.js';
import {
  launchWorkerSession,
  waitForObservation,
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
const marker = '[tau-question]';
let buffer = '';
let observed = false;

const observe = () => {
  if (observed) return;
  const at = buffer.indexOf(marker);
  if (at < 0) return;
  const match = buffer.slice(at + marker.length).match(/\\/\\S+/);
  if (match === null) return;
  const path = match[0].replace(/[^A-Za-z0-9/_.-].*$/s, '');
  appendFileSync(output, JSON.stringify({ path }) + '\\n');
  observed = true;
};

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  observe();
});
`;

const childAddress = async (hc: HcSession, parent: string): Promise<string> => {
  const list = await ls(hc.runtime, { all: true });
  const child = list.terminals.find((terminal) => terminal.parent === parent);

  if (child === undefined) {
    throw new Error(`No worker terminal under ${parent}.`);
  }

  return child.address;
};

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

// Keeps the last scan. The scan owner runs scans in order, so this one settles after the others.
const completionTracked = (scan: WorkerScan) => {
  let last: Promise<void> = Promise.resolve();

  return {
    scan: {
      scan: (context: DeliveryContext) => {
        last = scan.scan(context);

        return last;
      },
    },
    settled: () => last,
  };
};

const noDeadline: DeadlineWatchdog = { apply: () => Promise.resolve(), clear: () => undefined };

const deliveryContext = (entries: SessionEntry[]): DeliveryContext =>
  ({
    sessionManager: { getEntries: () => entries },
    ui: { notify: () => undefined },
  }) as unknown as DeliveryContext;

it('shows a real worker question once and carries the manager answer into its report', async () => {
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
  });

  const assignment = await waitForQuestion(worker.assignmentFilePath);

  if (worker.observationPath === undefined) {
    throw new Error('The fixture worker got no manager probe.');
  }

  const observation = await waitForObservation(worker.observationPath);
  const question = assignment.questions[0];

  if (question === undefined) {
    throw new Error('Worker saved no question.');
  }

  expect(observation.path).toBe(worker.assignmentFilePath);

  const messages: SentMessage[] = [];
  const entries: SessionEntry[] = [];
  const { pi, handlers } = recordingExtension(messages, entries);
  const context = deliveryContext(entries);

  const tracked = completionTracked(
    createWorkerScan(hc.runtime, createWorkerDelivery(pi), noDeadline),
  );

  registerWorkerScan(pi, tracked.scan);

  const input = handlers.get('input');
  const compact = handlers.get('session_compact');

  if (input === undefined || compact === undefined) {
    throw new Error('worker delivery handlers are not registered');
  }

  input({ text: `[tau-question] ${worker.assignmentFilePath}` }, context);
  input({ text: `[tau-question] ${worker.assignmentFilePath}` }, context);

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

  const workerAddress = await childAddress(hc, worker.managerAddress);

  expect(questionMessage?.content).toContain(`hc send ${workerAddress} "<answer>"`);

  const reply = `manager-reply-${randomBytes(6).toString('hex')}`;

  await send(hc.runtime, workerAddress, { text: reply });

  const reported = await waitForReport(worker.assignmentFilePath);

  expect(reported.report?.evidence).toContain(reply);
});

it('shows a question once in a fresh delivery after its note failed', async () => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  vi.stubEnv('HC_SESSION', hc.session);

  await installCommandShim('hc', {
    otherCalls: 'real',
    overrides: [{ match: ' send ', script: `printf '%s\\n' 'send refused' >&2; exit 1` }],
  });

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
