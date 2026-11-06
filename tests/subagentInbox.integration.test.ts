import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { executeAnswer } from '../src/extensions/subagents/answer.js';
import type { Assignment } from '../src/extensions/subagents/assignment.js';
import { readAssignment } from '../src/extensions/subagents/assignment.js';
import { workerContinuation, workerStartMessage } from '../src/extensions/subagents/workerStart.js';
import { workerTools } from '../src/extensions/subagents/workerTools.js';
import { skillTools } from '../src/skillTools.js';
import { startHcSession } from './hcSessionHarness.js';
import type { HcSession } from './hcSessionHarness.js';
import { createBoundSession, shutdownSession } from './piSession.js';
import { launchWorkerSession, waitForQuestion, waitForReport } from './subagentSessionHarness.js';
import type { WorkerSession } from './subagentSessionHarness.js';

interface AnswerEntry {
  content: unknown;
  questionId: unknown;
}

interface SessionLine {
  type?: unknown;
  customType?: unknown;
  content?: unknown;
  details?: { family?: unknown; questionId?: unknown };
}

vi.setConfig({ testTimeout: 120_000 });

// Inbox answer entries in a worker's saved session file.
const savedAnswerEntries = (sessionFile: string): AnswerEntry[] =>
  readFileSync(sessionFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as SessionLine)
    .filter((entry) => entry.type === 'custom_message')
    .filter((entry) => entry.customType === 'tau-inbox-message')
    .filter((entry) => entry.details?.family === 'answer')
    .map((entry) => ({ content: entry.content, questionId: entry.details?.questionId }));

const answerQuestion = (hc: HcSession, assignment: Assignment, answer: string) => {
  const question = assignment.questions[0];

  if (question === undefined) {
    throw new Error('Worker saved no question.');
  }

  return executeAnswer(hc.runtime, {
    parameters: { assignmentId: assignment.assignmentId, questionId: question.questionId, answer },
    parentSession: assignment.parentSession,
  });
};

const resultText = (result: Awaited<ReturnType<typeof executeAnswer>>): string =>
  result.content.map((block) => block.text).join('\n');

const recordDirectory = (agentDirectory: string): string => join(agentDirectory, 'tau', 'inbox');

// Saved records below the per-session directories, which stay after their records are deleted.
const savedRecords = (agentDirectory: string): string[] => {
  try {
    return readdirSync(recordDirectory(agentDirectory), { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
};

const startHc = async (): Promise<HcSession> => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  vi.stubEnv('HC_SESSION', hc.session);

  return hc;
};

it('queues an answer on the worker socket, shows it once, and leaves the assignment unchanged', async () => {
  const hc = await startHc();

  vi.resetModules();

  const { fixtureModel, holdReportTaskMarker, questionTaskMarker, reportReleaseFile } =
    await import('../src/extensions/subagents/fixtures/controlledProvider.js');

  const worker = await launchWorkerSession({
    hc,
    model: fixtureModel,
    task: `${questionTaskMarker} ${holdReportTaskMarker} Ask which value the report should hold.`,
    acceptance: ['Report the answer.'],
    tauPackage: true,
  });

  const asked = await waitForQuestion(worker.assignmentFilePath);
  const questionId = asked.questions[0]?.questionId;
  const assignmentText = readFileSync(worker.assignmentFilePath, 'utf8');
  const assignmentFiles = readdirSync(dirname(worker.assignmentFilePath));
  const reply = `manager-reply-${randomBytes(6).toString('hex')}`;

  const answered = await answerQuestion(hc, asked, reply);

  expect(answered.details).toMatchObject({ status: 'queued', messageId: questionId });

  await vi.waitFor(
    () => {
      expect(savedAnswerEntries(asked.session.file)).toHaveLength(1);
    },
    { timeout: 30_000 },
  );

  // The worker holds its report, so the question is still open and only the text differs.
  const conflicting = await answerQuestion(hc, asked, 'Use another value.');

  expect(conflicting.isError).toBe(true);
  expect(resultText(conflicting)).toContain('already has another answer');

  const retried = await answerQuestion(hc, asked, reply);

  expect(retried.details).toMatchObject({ status: 'queued', messageId: questionId });

  expect({
    assignment: readFileSync(worker.assignmentFilePath, 'utf8'),
    files: readdirSync(dirname(worker.assignmentFilePath)),
    entries: savedAnswerEntries(asked.session.file),
  }).toEqual({
    assignment: assignmentText,
    files: assignmentFiles,
    entries: [{ content: reply, questionId }],
  });

  writeFileSync(join(asked.cwd, reportReleaseFile), '');

  const reported = await waitForReport(worker.assignmentFilePath);

  expect(reported.report?.evidence).toEqual([reply]);
  expect(savedAnswerEntries(asked.session.file)).toHaveLength(1);
});

// A worker terminal whose own program idles, so this process can run its Pi session in-process.
const idleWorkerProgram = { source: 'setInterval(() => undefined, 60_000);\n' };

const safetyPackage = dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json')));

const workerExtensionPaths = [
  fileURLToPath(new URL('../src/extensions/subagents/workerExtension.ts', import.meta.url)),
  fileURLToPath(new URL('../src/extensions/inbox/inbox.ts', import.meta.url)),
  safetyPackage,
];

// Points this process's hc calls at the test's core, and makes this process the worker.
const becomeWorker = (hc: HcSession, worker: WorkerSession): void => {
  for (const [name, value] of Object.entries(hc.environment)) {
    if (name !== 'PATH') {
      vi.stubEnv(name, value);
    }
  }

  vi.stubEnv('TAU_ROLE', 'worker');
  vi.stubEnv('PI_CODING_AGENT_DIR', worker.agentDirectory);
  vi.stubEnv('HC_TERMINAL_ID', worker.workerAddress);
};

const lastUserText = (context: TranscriptContext): string =>
  JSON.stringify(context.messages.findLast((message) => message.role === 'user')?.content);

const reportSummary =
  'Fixture report.\n\nChanges: None\nEvidence: None\nDecisions: None\nConcerns: None';

it('resumes a saved worker session without waiting once it holds the answer receipt', async () => {
  const hc = await startHc();

  vi.resetModules();

  const { fixtureModel } =
    await import('../src/extensions/subagents/fixtures/controlledProvider.js');

  const worker = await launchWorkerSession({
    hc,
    model: fixtureModel,
    task: 'Ask which value the report should hold.',
    acceptance: ['Report the answer.'],
    command: idleWorkerProgram,
  });

  const launched = await readAssignment(worker.assignmentFilePath);

  if (launched === undefined) {
    throw new Error('The launch saved no assignment.');
  }

  becomeWorker(hc, worker);

  const provider = fauxProvider({ provider: fixtureModel.provider, api: fixtureModel.api });

  provider.setResponses([
    fauxAssistantMessage([fauxToolCall('subagent_question', { question: 'Which value?' })]),
    fauxAssistantMessage('Noted the answer.'),
    fauxAssistantMessage('Still noted.'),
    (context) =>
      fauxAssistantMessage([
        fauxToolCall('subagent_report', {
          outcome: 'success',
          summary: reportSummary,
          evidence: [lastUserText(context)],
        }),
      ]),
  ]);

  const startSession = () =>
    createBoundSession(
      () => undefined,
      {
        cwd: launched.cwd,
        agentDirectory: worker.agentDirectory,
        providers: [provider],
        tools: workerTools(launched.loadout, skillTools),
        extensionPaths: workerExtensionPaths,
        sessionManager: SessionManager.open(launched.session.file),
      },
      { onError: () => undefined },
    );

  const { session } = await startSession();

  await session.prompt(workerStartMessage);

  const asked = await waitForQuestion(worker.assignmentFilePath);

  // The reloaded inbox takes the answer, so the worker's answer check survives a reload.
  await session.reload();

  vi.stubEnv('HC_TERMINAL_ID', worker.managerAddress);

  const answered = await answerQuestion(hc, asked, 'Use 42.');

  vi.stubEnv('HC_TERMINAL_ID', worker.workerAddress);

  expect(answered.details).toMatchObject({ status: 'queued' });

  await vi.waitFor(() => {
    expect(provider.state.callCount).toBe(3);
  });

  await session.waitForIdle();
  await shutdownSession(session);

  const resumed = await startSession();

  await resumed.session.prompt(workerStartMessage);

  const reported = await waitForReport(worker.assignmentFilePath);

  await shutdownSession(resumed.session);

  expect({
    evidence: reported.report?.evidence,
    entries: savedAnswerEntries(launched.session.file),
    records: savedRecords(worker.agentDirectory),
  }).toEqual({
    evidence: [JSON.stringify([{ type: 'text', text: workerContinuation }])],
    entries: [{ content: 'Use 42.', questionId: asked.questions[0]?.questionId }],
    records: [],
  });
});
