import { join, resolve } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import type { Exec } from '../src/command.js';
import { planReportText } from '../src/extensions/plan/plan.js';
import type { PlanStep } from '../src/extensions/plan/steps.js';
import { assignmentPath, writeAssignment } from '../src/extensions/subagents/assignment.js';
import type { DeadlineWatchdog } from '../src/extensions/subagents/deadlineWatchdog.js';
import {
  manager,
  savedAssignment,
  savedReport,
} from '../src/extensions/subagents/fixtures/deliveryManager.js';
import { createWorkerDelivery } from '../src/extensions/subagents/workerDelivery.js';
import type { WorkerDelivery } from '../src/extensions/subagents/workerDelivery.js';
import { createWorkerScan } from '../src/extensions/subagents/workerScan.js';
import type { HcRuntime, HcTerminal } from '../src/hc/hc.js';
import tauRegistration from '../src/tau/tau.js';
import { installHcCommand } from './hcCommandHarness.js';
import { createBoundSession } from './piSession.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface RecordingDelivery {
  delivery: WorkerDelivery;
  messages: { customType?: unknown; content?: unknown; details?: unknown }[];
}

const mixedPlan: PlanStep[] = [
  { text: 'Brief worker', status: 'completed' },
  { text: 'Review change', status: 'in_progress' },
  { text: 'Open the PR', status: 'pending' },
];

const planSuffix =
  '\n\nCurrent plan:\n[completed] Brief worker\n[in_progress] Review change\n[pending] Open the PR\n\nUpdate `plan` if this report finishes or blocks a step.';

const noDeadline: DeadlineWatchdog = { apply: () => Promise.resolve(), clear: () => undefined };

const bundledWebAccessExtensionPath = resolve(
  import.meta.dirname,
  '../node_modules/pi-web-access/dist/index.js',
);

const succeeded = (value: unknown) => ({
  code: 0,
  killed: false,
  truncated: false,
  stdout: JSON.stringify(value),
  stderr: '',
});

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

      const reply =
        terminal === undefined
          ? { code: 1, killed: false, truncated: false, stdout: '', stderr: 'not_found' }
          : succeeded(terminal);

      return Promise.resolve(reply);
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

const recordingDelivery = (): RecordingDelivery => {
  const messages: RecordingDelivery['messages'] = [];

  const pi = {
    on: () => undefined,
    sendMessage: (message: RecordingDelivery['messages'][number]) => {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;

  return { delivery: createWorkerDelivery(pi, planReportText), messages };
};

const reportText = (assignmentId: string): string =>
  `Worker report ${assignmentId}: success\n\nChanges: None\nEvidence: None\nDecisions: None\nConcerns: None\n\nEvidence:\n- a reference`;

const setup = async (plan: PlanStep[] | undefined) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-plan-report-');
  const { bin, log } = installHcCommand(directory);

  vi.stubEnv('TAU_ROLE', 'lead');
  vi.stubEnv('HC_TERMINAL_ID', manager);
  vi.stubEnv('HC_SESSION', 'tau-plan-report');
  vi.stubEnv('HC_FAKE_LOG', log);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const provider = fauxProvider({ provider: 'tau-plan-report' });
  const errors: unknown[] = [];

  onTestFinished(() => {
    expect(errors).toEqual([]);
  });

  const sessionManager = SessionManager.create(directory, join(directory, 'sessions'));

  const { session } = await createBoundSession(
    onTestFinished,
    {
      cwd: directory,
      agentDirectory: directory,
      providers: [provider],
      tools: ['plan', 'web_search', 'fetch_content'],
      extensionPaths: [bundledWebAccessExtensionPath],
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
      sessionManager,
      extensionFactories: [tauRegistration],
    },
    { onError: (error) => errors.push(error) },
  );

  if (plan !== undefined) {
    provider.setResponses([
      fauxAssistantMessage([fauxToolCall('plan', { steps: plan })]),
      fauxAssistantMessage('Plan saved.'),
    ]);

    await session.prompt('Save the plan.');
  }

  const sessionFile = session.sessionManager.getSessionFile();

  if (sessionFile === undefined) {
    throw new Error('The lead session has no session file.');
  }

  const saved = { ...savedAssignment(directory, savedReport()), parentSession: sessionFile };

  await writeAssignment(saved);

  const hc = createHc([
    {
      address: 't-child',
      state: 'live',
      parent: manager,
      labels: { 'tau.assignment': assignmentPath(saved.assignmentId) },
    },
  ]);

  const { delivery, messages } = recordingDelivery();
  const notices: string[] = [];

  const context = {
    sessionManager: session.sessionManager,
    ui: { notify: (message: string) => notices.push(message) },
    isIdle: () => true,
    signal: undefined,
  } as unknown as Parameters<WorkerDelivery['deliver']>[0];

  await createWorkerScan(
    hc,
    delivery,
    noDeadline,
    temporaryDirectory(onTestFinished, 'tau-sweep-'),
  ).scan(context);

  return { messages, notices, assignmentId: saved.assignmentId };
};

it('ends a report to a lead with a plan with the plan and the update line', async () => {
  const { messages, notices, assignmentId } = await setup(mixedPlan);

  expect(notices).toEqual([]);
  expect(messages).toHaveLength(1);

  const message = messages[0] as { customType: string; content: string; details: unknown };

  expect(message.customType).toBe('tau-worker-report');
  expect(message.details).toEqual({ assignmentId, outcome: 'success' });
  expect(message.content).toBe(`${reportText(assignmentId)}${planSuffix}`);
});

it('leaves a report to a lead without a plan unchanged', async () => {
  const { messages, notices, assignmentId } = await setup(undefined);

  expect(notices).toEqual([]);
  expect(messages).toHaveLength(1);

  const message = messages[0] as { content: string };

  expect(message.content).toBe(reportText(assignmentId));
});
