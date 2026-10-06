import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { FauxResponseStep } from '@earendil-works/pi-ai';
import { SessionManager, createCodemodeExtension } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import askUserQuestionExtension from '../src/extensions/askUserQuestion/askUserQuestion.js';
import { readWorkerActivity } from '../src/extensions/subagents/activity.js';
import { fixtureLoadout } from '../src/extensions/subagents/fixtures/loadout.js';
import { nativeIdentity, seedSession, workerTools } from '../src/extensions/subagents/profiles.js';
import { readPendingQuestion } from '../src/extensions/subagents/questionRecords.js';
import {
  publish,
  readReport,
  recordEvent,
  validateTask,
  workerRecordsDirectory,
} from '../src/extensions/subagents/records.js';
import subagentsExtension, {
  registerCapacityRefusal,
} from '../src/extensions/subagents/subagents.js';
import workerExtension from '../src/extensions/subagents/workerExtension.js';
import { createBoundSession } from './piSession.js';

interface ToolOutcome {
  toolName: string;
  isError: boolean;
  text: string;
}

const safetyExtension = join(
  dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
  'dist',
  'pi',
  'index.js',
);

// A script's `return` value is the last text block of the codemode result, as JSON.
const scriptValue = (outcomes: ToolOutcome[]): unknown => {
  const script = outcomes.find((outcome) => outcome.toolName === 'codemode');

  if (!script || script.isError) {
    throw new Error(`Script did not complete: ${script?.text ?? 'no codemode call'}`);
  }

  const result = JSON.parse(script.text) as { content: { type: string; text?: string }[] };
  const output = result.content.findLast((block) => block.type === 'text')?.text ?? '';

  return JSON.parse(output);
};

const handover = 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None';

const codemodeCall = (code: string) => fauxAssistantMessage([fauxToolCall('codemode', { code })]);

// Runs a dispatched worker task whose model follows `responses`, then waits until Pi settles.
const runWorker = async (responses: FauxResponseStep[]) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-codemode-worker-'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  const taskDirectory = join(directory, 'task');
  mkdirSync(taskDirectory);
  vi.stubEnv('TAU_WORKER_RECORD', taskDirectory);
  const provider = fauxProvider({ provider: 'tau-codemode-fixture' });
  const model = provider.getModel();

  const task = validateTask({
    version: 7,
    taskId: 'codemode-task',
    task: 'Inspect source.txt.',
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent',
    ...nativeIdentity(taskDirectory),
    createdAt: Date.now(),
    deadline: Date.now() + 30_000,
    cancellationBudget: 2000,
    monotonicDeadline: Date.now() + 30_000,
    loadout: {
      harness: 'pi',
      profile: 'worker',
      role: 'investigation',
      model: `${model.provider}/${model.id}`,
      thinking: 'off',
      cwd: directory,
      agentDirectory: directory,
      permissions: 'trusted-full-tools',
      instructions: 'Inspect the fixture only.',
      tools: ['read', 'bash', 'codemode', 'ask_user_question'],
      skills: [],
      instructionSets: [],
      packages: [],
    },
  });

  publish(taskDirectory, 'task.json', task);
  seedSession(task);
  writeFileSync(join(directory, 'source.txt'), 'fixture-source');

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [provider],
    tools: workerTools(task.loadout),
    sessionManager: SessionManager.open(task.nativeSessionFile),
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    extensionPaths: [safetyExtension],
    extensionFactories: [
      createCodemodeExtension({ mode: 'on' }),
      askUserQuestionExtension,
      workerExtension,
    ],
  });

  const outcomes: ToolOutcome[] = [];
  const settled = Promise.withResolvers<undefined>();

  session.subscribe((event) => {
    if (event.type === 'tool_execution_end') {
      outcomes.push({
        toolName: event.toolName,
        isError: event.isError,
        text: JSON.stringify(event.result),
      });
    }

    if (event.type === 'agent_settled') {
      settled.resolve(undefined);
    }
  });

  provider.setResponses(responses);
  publish(taskDirectory, 'dispatch.json', { taskId: task.taskId });
  await settled.promise;

  return { taskDirectory, taskId: task.taskId, outcomes };
};

const savedTaskId = 'saved-task';

const seedStoppedChild = (directory: string, sessionManager: SessionManager): void => {
  const taskDirectory = join(workerRecordsDirectory(), savedTaskId);
  mkdirSync(taskDirectory, { recursive: true });

  const task = validateTask({
    version: 7,
    taskId: savedTaskId,
    task: 'Inspect source.txt.',
    parentSession: sessionManager.getSessionFile(),
    parentSessionId: sessionManager.getSessionId(),
    ...nativeIdentity(taskDirectory),
    createdAt: 1000,
    deadline: 20_000,
    cancellationBudget: 1000,
    monotonicDeadline: 20_000,
    loadout: fixtureLoadout(directory),
  });

  publish(taskDirectory, 'task.json', task);
  recordEvent(taskDirectory, savedTaskId, 'cleanup', { detail: 'Pane removed.', stopped: true });
};

// Runs one prompt in a manager session outside herdr, whose model follows `responses`.
const runManager = async (responses: FauxResponseStep[]) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-codemode-manager-'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('HERDR_ENV', '0');
  vi.stubEnv('HERDR_PANE_ID', '');
  const provider = fauxProvider({ provider: 'tau-codemode-manager' });
  const sessionManager = SessionManager.create(directory, join(directory, 'sessions'));
  seedStoppedChild(directory, sessionManager);

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [provider],
    tools: ['read', 'codemode', 'ask_user_question', ...managerTools],
    sessionManager,
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    extensionFactories: [
      createCodemodeExtension({ mode: 'on' }),
      askUserQuestionExtension,
      (pi) => {
        subagentsExtension(pi, registerCapacityRefusal(pi));
      },
    ],
  });

  const outcomes: ToolOutcome[] = [];

  session.subscribe((event) => {
    if (event.type === 'tool_execution_end') {
      outcomes.push({
        toolName: event.toolName,
        isError: event.isError,
        text: JSON.stringify(event.result),
      });
    }
  });

  provider.setResponses(responses);
  await session.prompt('Check earlier workers.');

  return outcomes;
};

// Each attempt settles to its value or 'rejected', so one refused call cannot hide another.
const settle = (calls: string[]) =>
  [
    'const attempt = async (call) => call();',
    `const settled = await Promise.allSettled([${calls.map((call) => `attempt(() => ${call})`).join(', ')}]);`,
    "const outcomes = settled.map((entry) => (entry.status === 'fulfilled' ? entry.value : 'rejected'));",
  ].join('\n');

const discovery = [
  'const listed = ALL_TOOLS.map((tool) => tool.name);',
  "const found = (await searchTools('subagent worker report question progress ask user', { limit: 50 })).map((tool) => tool.name);",
].join('\n');

const workerControlTools = new Set([
  'subagent_report',
  'subagent_question',
  'subagent_progress',
  'ask_user_question',
]);

const managerTools = [
  'subagent',
  'subagent_follow_up',
  'subagent_history',
  'subagent_status',
  'subagent_reply',
  'subagent_cancel',
];

const managerControlTools = new Set([
  'subagent',
  'subagent_follow_up',
  'subagent_reply',
  'subagent_cancel',
  'ask_user_question',
]);

const stopWithoutReport = [
  fauxAssistantMessage('Stopping without a report.'),
  fauxAssistantMessage('Stopping without a report.'),
];

it('fails a script call to subagent_report without saving a report', async () => {
  const report = JSON.stringify({ outcome: 'success', summary: handover, evidence: [] });

  const { taskDirectory, taskId, outcomes } = await runWorker([
    codemodeCall(`${settle([`tools.subagent_report(${report})`])}\nreturn outcomes;`),
    ...stopWithoutReport,
  ]);

  expect(scriptValue(outcomes)).toEqual(['rejected']);
  expect(readReport(taskDirectory, taskId)).toBeUndefined();
});

it('hides worker control tools from scripts and saves no record for their calls', async () => {
  const report = JSON.stringify({ outcome: 'success', summary: handover, evidence: [] });

  const questionnaire = JSON.stringify({
    questions: [
      {
        header: 'Fixture',
        question: 'Which file?',
        options: [
          { label: 'Source', description: 'Inspect source.' },
          { label: 'Test', description: 'Inspect tests.' },
        ],
      },
    ],
  });

  const script = [
    discovery,
    settle([
      `tools.subagent_report(${report})`,
      "tools.subagent_question({ question: 'Which file?' })",
      "tools.subagent_progress({ description: 'Reading source' })",
      `tools.ask_user_question(${questionnaire})`,
    ]),
    'return { listed, found, outcomes };',
  ].join('\n');

  const { taskDirectory, taskId, outcomes } = await runWorker([
    codemodeCall(script),
    ...stopWithoutReport,
  ]);

  const value = scriptValue(outcomes) as { listed: string[]; found: string[]; outcomes: unknown[] };

  expect(value.listed).toContain('read');
  expect(value.listed.filter((name) => workerControlTools.has(name))).toEqual([]);
  expect(value.found.filter((name) => workerControlTools.has(name))).toEqual([]);
  expect(value.outcomes).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
  expect(readReport(taskDirectory, taskId)).toBeUndefined();
  expect(readPendingQuestion(taskDirectory, taskId)).toBeUndefined();
  expect(readWorkerActivity(taskDirectory, taskId)?.description).toBeUndefined();
});

it('returns ordinary results beside a refused control call in one script', async () => {
  const report = JSON.stringify({ outcome: 'success', summary: handover, evidence: [] });

  const script = [
    settle([
      "tools.read({ path: 'source.txt' })",
      "tools.bash({ command: 'printf bash-ok' }).then((result) => result.output)",
      `tools.subagent_report(${report})`,
    ]),
    'return outcomes;',
  ].join('\n');

  const { taskDirectory, taskId, outcomes } = await runWorker([
    codemodeCall(script),
    ...stopWithoutReport,
  ]);

  const [read, bash, control] = scriptValue(outcomes) as unknown[];

  expect(read).toContain('fixture-source');
  expect(bash).toBe('bash-ok');
  expect(control).toBe('rejected');
  expect(readReport(taskDirectory, taskId)).toBeUndefined();
});

it('lets manager scripts read worker status and history but not control workers', async () => {
  const script = [
    discovery,
    settle([
      `tools.subagent_status({ taskId: '${savedTaskId}' }).then((result) => result.includes('${savedTaskId}'))`,
      `tools.subagent_history({}).then((result) => result.includes('${savedTaskId}'))`,
      `tools.subagent_cancel({ taskId: '${savedTaskId}' })`,
    ]),
    'return { listed, found, outcomes };',
  ].join('\n');

  const outcomes = await runManager([codemodeCall(script), fauxAssistantMessage('Done.')]);
  const value = scriptValue(outcomes) as { listed: string[]; found: string[]; outcomes: unknown[] };

  expect(value.listed).toEqual(expect.arrayContaining(['subagent_status', 'subagent_history']));
  expect(value.listed.filter((name) => managerControlTools.has(name))).toEqual([]);
  expect(value.found.filter((name) => managerControlTools.has(name))).toEqual([]);
  expect(value.outcomes).toEqual([true, true, 'rejected']);
});
