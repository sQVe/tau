import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { readAssignment } from '../src/extensions/subagents/assignment.js';
import { createDeadlineWatchdog } from '../src/extensions/subagents/deadlineWatchdog.js';
import { createWorkerDelivery } from '../src/extensions/subagents/workerDelivery.js';
import { createWorkerScan } from '../src/extensions/subagents/workerScan.js';
import { runWithEnvironment } from '../src/hc/connect.js';
import { get, label, ls } from '../src/hc/hc.js';
import { startHcSession } from './hcSessionHarness.js';
import type { HcSession } from './hcSessionHarness.js';
import { launchWorkerSession } from './subagentSessionHarness.js';
import type { WorkerSession } from './subagentSessionHarness.js';

interface Notice {
  message: string;
  level: string;
}

// What the manager shows: messages from the watchdog's delivery and notices from its ui.
interface ManagerView {
  pi: ExtensionAPI;
  context: Pick<ExtensionContext, 'sessionManager' | 'ui'>;
  messages: string[];
  notices: Notice[];
}

vi.mock(import('../src/extensions/subagents/loadout.js'), { spy: true });

vi.setConfig({ testTimeout: 120_000 });

const waitMilliseconds = 90_000;
const pollMilliseconds = 100;
const workerTimeoutSeconds = 10;

const warningPattern =
  /Deadline in \d+ s: call subagent_report now with what you have; blockerKind time is accepted\./;

// Writes each stdin chunk to input.txt and keeps running. It writes ready only after it listens.
const neverReportingProgram = `
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => appendFileSync(join(directory, 'input.txt'), chunk));
writeFileSync(join(directory, 'ready'), '');
setInterval(() => undefined, 1_000_000);
`;

const waitUntil = async (condition: () => boolean, message: string): Promise<void> => {
  const deadline = Date.now() + waitMilliseconds;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(message);
    }

    await delay(pollMilliseconds);
  }
};

const managerView = (): ManagerView => {
  const messages: string[] = [];
  const entries: { type: string; customType: string; details: unknown }[] = [];
  const notices: Notice[] = [];

  const pi = {
    sendMessage: (message: { customType: string; content: string; details: unknown }) => {
      messages.push(message.content);

      entries.push({
        type: 'custom_message',
        customType: message.customType,
        details: message.details,
      });
    },
  } as unknown as ExtensionAPI;

  const context = {
    sessionManager: { getEntries: () => entries },
    ui: {
      notify: (message: string, level: string) => {
        notices.push({ message, level });
      },
    },
  } as unknown as ManagerView['context'];

  return { pi, context, messages, notices };
};

// A reload builds a new watchdog. Each test starts one, as the manager does on session start.
const startWatchdog = (hc: HcSession, view: ManagerView) => {
  const delivery = createWorkerDelivery(view.pi);
  const watchdog = createDeadlineWatchdog(hc.runtime, delivery);

  return { watchdog, scan: createWorkerScan(hc.runtime, delivery, watchdog) };
};

const prepareTest = (): void => {
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
};

const launchWorker = async (hc: HcSession): Promise<WorkerSession> => {
  vi.stubEnv('HC_SESSION', hc.session);

  vi.resetModules();

  const { fixtureModel } =
    await import('../src/extensions/subagents/fixtures/controlledProvider.js');

  const worker = await launchWorkerSession({
    hc,
    model: fixtureModel,
    task: 'Wait for the manager.',
    acceptance: ['The worker keeps running until the manager ends it.'],
    command: { source: neverReportingProgram },
    timeoutSeconds: workerTimeoutSeconds,
  });

  await waitUntil(
    () => existsSync(join(worker.agentDirectory, 'ready')),
    `Worker never became ready in ${worker.agentDirectory}.`,
  );

  return worker;
};

const deadlineOf = async (worker: WorkerSession): Promise<number> => {
  const assignment = await readAssignment(worker.assignmentFilePath);

  if (assignment === undefined) {
    throw new Error(`No assignment at ${worker.assignmentFilePath}.`);
  }

  return assignment.deadline;
};

const workerAddress = async (hc: HcSession, worker: WorkerSession): Promise<string> => {
  const list = await ls(hc.runtime, {
    all: true,
    labels: { 'tau.assignment': worker.assignmentFilePath },
  });

  const child = list.terminals.find((terminal) => terminal.parent === worker.managerAddress);

  if (child === undefined) {
    throw new Error(`No manager child for ${worker.assignmentFilePath}.`);
  }

  return child.address;
};

const workerState = async (hc: HcSession, worker: WorkerSession): Promise<string> => {
  const terminal = await get(hc.runtime, await workerAddress(hc, worker));

  return terminal.state;
};

it('warns a worker at its short deadline, then ends it', async () => {
  const hc = await startHcSession(onTestFinished);

  prepareTest();

  const worker = await launchWorker(hc);
  const deadline = await deadlineOf(worker);
  const view = managerView();

  await startWatchdog(hc, view).scan.scan(view.context);

  const inputPath = join(worker.agentDirectory, 'input.txt');

  await waitUntil(
    () => existsSync(inputPath) && warningPattern.test(readFileSync(inputPath, 'utf8')),
    'The worker never received the deadline warning.',
  );

  await waitUntil(() => view.messages.length === 1, 'The manager never showed the worker end.');

  expect(view.messages).toEqual([expect.stringContaining('ended at its deadline')]);
  expect(view.notices).toEqual([]);
  expect(Date.now()).toBeGreaterThanOrEqual(deadline);
  expect(await workerState(hc, worker)).toBe('finished');
});

it('ends an overdue worker after a manager reload builds a new watchdog', async () => {
  const hc = await startHcSession(onTestFinished);

  prepareTest();

  const worker = await launchWorker(hc);
  const deadline = await deadlineOf(worker);
  const view = managerView();
  const beforeReload = startWatchdog(hc, view);

  await beforeReload.scan.scan(view.context);
  beforeReload.watchdog.clear();

  await waitUntil(() => Date.now() >= deadline, 'The deadline never passed.');

  expect(await workerState(hc, worker)).toBe('live');

  await startWatchdog(hc, view).scan.scan(view.context);

  await waitUntil(
    () => view.messages.length === 1,
    'The reloaded watchdog never ended the worker.',
  );

  expect(view.messages).toEqual([expect.stringContaining('ended at its deadline')]);
  expect(await workerState(hc, worker)).toBe('finished');
});

it('shows an error for a malformed tau.deadline label and still ends the worker at its deadline', async () => {
  const hc = await startHcSession(onTestFinished);

  prepareTest();

  const worker = await launchWorker(hc);
  const deadline = await deadlineOf(worker);

  await label(hc.runtime, await workerAddress(hc, worker), { 'tau.deadline': 'soon' });

  const view = managerView();

  await startWatchdog(hc, view).scan.scan(view.context);

  expect(view.notices).toEqual([expect.objectContaining({ level: 'error' })]);
  expect(view.notices[0]?.message).toContain('"soon"');

  await waitUntil(() => view.messages.length === 1, 'The manager never showed the worker end.');

  expect(Date.now()).toBeGreaterThanOrEqual(deadline);
  expect(await workerState(hc, worker)).toBe('finished');
});

it('never ends a terminal that is not the manager child, even with an expired deadline label', async () => {
  const hc = await startHcSession(onTestFinished);

  prepareTest();

  const worker = await launchWorker(hc);

  const stranger = await runWithEnvironment(hc.runtime, {
    argv: ['sleep', '60'],
    name: 'stranger',
    env: {},
    noParent: true,
    labels: { 'tau.assignment': worker.assignmentFilePath, 'tau.deadline': '1' },
  });

  const view = managerView();

  await startWatchdog(hc, view).scan.scan(view.context);

  await waitUntil(() => view.messages.length === 1, 'The manager never showed the worker end.');

  expect(await workerState(hc, worker)).toBe('finished');
  expect((await get(hc.runtime, stranger.address)).state).toBe('live');
});
