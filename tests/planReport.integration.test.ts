import { join, resolve } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type {
  AgentSession,
  CustomMessageEntry,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import type { PlanStep } from '../src/extensions/plan/steps.js';
import { assignmentPath, writeAssignment } from '../src/extensions/subagents/assignment.js';
import { reportMessageType } from '../src/extensions/subagents/workerMessage.js';
import type { HcTerminal } from '../src/hc/hc.js';
import tauRegistration from '../src/tau/tau.js';
import { manager, savedAssignment, savedReport } from './deliveryManager.js';
import { installHcCommand } from './hcCommandHarness.js';
import { createBoundSession } from './piSession.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const mixedPlan: PlanStep[] = [
  { text: 'Brief worker', status: 'completed' },
  { text: 'Review change', status: 'in_progress' },
  { text: 'Open the PR', status: 'pending' },
];

const planSuffix =
  '\n\nCurrent plan:\n[completed] Brief worker\n[in_progress] Review change\n[pending] Open the PR\n\nUpdate `plan` if this report finishes or blocks a step.';

const bundledWebAccessExtensionPath = resolve(
  import.meta.dirname,
  '../node_modules/pi-web-access/dist/index.js',
);

const reportText = (assignmentId: string): string =>
  `Worker report ${assignmentId}: success\n\nChanges: None\nEvidence: None\nDecisions: None\nConcerns: None\n\nEvidence:\n- a reference`;

const isReportEntry = (entry: SessionEntry): entry is CustomMessageEntry =>
  entry.type === 'custom_message' && entry.customType === reportMessageType;

const reportEntries = (session: AgentSession) =>
  session.sessionManager.getEntries().filter(isReportEntry);

const setup = async (plan: PlanStep[] | undefined) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-plan-report-');
  const { bin, log, replies, reply, replyGet } = installHcCommand(directory);

  vi.stubEnv('TAU_ROLE', 'lead');
  vi.stubEnv('HC_TERMINAL_ID', manager);
  vi.stubEnv('HC_SESSION', 'tau-plan-report');
  vi.stubEnv('HC_FAKE_LOG', log);
  vi.stubEnv('HC_FAKE_REPLIES', replies);
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

  // Delivery matches a report only when its assignment names this session's file, so this test
  // needs a saved session rather than an in-memory one.
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

  // The awaited emit joins the worker scan. A scan left running writes into the temporary
  // directory after its removal starts, which fails the removal with ENOTEMPTY.
  onTestFinished(async () => {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  });

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

  const terminal: HcTerminal = {
    address: 't-child',
    state: 'live',
    parent: manager,
    labels: { 'tau.assignment': assignmentPath(saved.assignmentId) },
  };

  reply(
    'ls',
    JSON.stringify({
      terminals: [{ address: terminal.address, state: terminal.state, parent: terminal.parent }],
    }),
  );

  replyGet(terminal.address, JSON.stringify(terminal));

  provider.setResponses([fauxAssistantMessage('Noted.')]);

  // Tau's own registered scan runs on session_start, so the delivered report proves the wiring
  // from the package root through the plan suffix and into the scan.
  await session.extensionRunner.emit({ type: 'session_start', reason: 'reload' });

  await vi.waitFor(
    () => {
      expect(reportEntries(session)).toHaveLength(1);
    },
    { timeout: 10_000 },
  );

  return { entries: reportEntries(session), assignmentId: saved.assignmentId };
};

it('ends a report to a lead with a plan with the plan and the update line', async () => {
  const { entries, assignmentId } = await setup(mixedPlan);

  expect(entries).toHaveLength(1);

  const entry = entries[0];

  expect(entry?.details).toEqual({ assignmentId, outcome: 'success' });
  expect(entry?.content).toBe(`${reportText(assignmentId)}${planSuffix}`);
});

it('leaves a report to a lead without a plan unchanged', async () => {
  const { entries, assignmentId } = await setup(undefined);

  expect(entries).toHaveLength(1);

  expect(entries[0]?.content).toBe(reportText(assignmentId));
});
