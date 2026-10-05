import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import type { FauxResponseStep } from '@earendil-works/pi-ai';
import { SessionManager, createCodemodeExtension } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { expect, it, onTestFinished, vi } from 'vitest';

import {
  nativeIdentity,
  resolveProfile,
  seedSession,
  workerTools,
} from '../src/extensions/subagents/profiles.js';
import { publish, readEvent, validateTask } from '../src/extensions/subagents/records.js';
import workerExtension from '../src/extensions/subagents/workerExtension.js';
import workflowExtension, { codemodeGuidelines } from '../src/extensions/workflow.js';
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

// Bundled profiles name tools from other packages. Workers refuse to start without them.
const packageTools = [
  'web_search',
  'fetch_content',
  'get_search_content',
  'run_tests',
  'commit',
  'agent_browser',
  'agent_browser_code',
];

const registerPackageTools = (pi: ExtensionAPI) => {
  for (const name of packageTools) {
    pi.registerTool({
      name,
      label: name,
      description: `Fixture ${name}.`,
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: 'text', text: name }], details: {} }),
    });
  }
};

const temporaryDirectory = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));

  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  return directory;
};

// Starts a worker session from a bundled or custom profile, as a launched Pi worker would.
const startProfileWorker = async (directory: string, profileName: string) => {
  const taskDirectory = join(directory, 'task');
  mkdirSync(taskDirectory);
  vi.stubEnv('TAU_WORKER_RECORD', taskDirectory);
  const provider = fauxProvider({ provider: 'tau-profile-codemode' });
  const model = provider.getModel();
  const profile = resolveProfile(directory, directory, true, profileName);

  if (!profile) {
    throw new Error(`Profile not found: ${profileName}`);
  }

  const task = validateTask({
    version: 7,
    taskId: `${profileName}-task`,
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
      profile: profileName,
      role: profile.role,
      model: `${model.provider}/${model.id}`,
      thinking: 'off',
      cwd: directory,
      agentDirectory: directory,
      permissions: 'trusted-full-tools',
      instructions: profile.instructions,
      tools: profile.tools,
      skills: [],
      instructionSets: profile.instructionSets,
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
      registerPackageTools,
      workflowExtension,
      workerExtension,
    ],
  });

  return { session, provider, taskDirectory, taskId: task.taskId };
};

// Dispatches the task and waits until the worker's model follows `responses` to the end.
const runTask = async (
  worker: Awaited<ReturnType<typeof startProfileWorker>>,
  responses: FauxResponseStep[],
): Promise<ToolOutcome[]> => {
  const outcomes: ToolOutcome[] = [];
  const settled = Promise.withResolvers<undefined>();

  worker.session.subscribe((event) => {
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

  worker.provider.setResponses(responses);
  publish(worker.taskDirectory, 'dispatch.json', { taskId: worker.taskId });
  await settled.promise;

  return outcomes;
};

const stopWithoutReport = [
  fauxAssistantMessage('Stopping without a report.'),
  fauxAssistantMessage('Stopping without a report.'),
];

// Answers the first turn with a text reply and returns the system prompt that turn used.
const captureSystemPrompt = () => {
  const captured: { systemPrompt?: string } = {};

  const step: FauxResponseStep = (context) => {
    captured.systemPrompt = getCurrentSystemPrompt(context.messages);

    return fauxAssistantMessage('Stopping without a report.');
  };

  return { captured, step };
};

const hasCodemodeGuidelines = (systemPrompt: string | undefined): boolean =>
  codemodeGuidelines.every((guideline) => systemPrompt?.includes(guideline) === true);

it.for([
  ['scout', true],
  ['reviewer', true],
  ['worker', true],
  ['qa', false],
  ['browser', false],
] as const)('gives the bundled %s profile codemode: %s', async ([profileName, expected]) => {
  const directory = temporaryDirectory('tau-profile-codemode-');
  const worker = await startProfileWorker(directory, profileName);

  expect(readEvent(worker.taskDirectory, worker.taskId, 'ready')).toBeDefined();
  expect(worker.session.getActiveToolNames().includes('codemode')).toBe(expected);
});

it('refuses a scout script call to a tool the profile does not list', async () => {
  const directory = temporaryDirectory('tau-scout-codemode-');
  const worker = await startProfileWorker(directory, 'scout');

  const script =
    "await tools.edit({ path: 'source.txt', edits: [{ oldText: 'fixture', newText: 'edited' }] });";

  const outcomes = await runTask(worker, [
    fauxAssistantMessage([fauxToolCall('codemode', { code: script })]),
    ...stopWithoutReport,
  ]);

  const result = outcomes.find((outcome) => outcome.toolName === 'codemode');

  expect(result?.isError).toBe(true);
  expect(result?.text).toContain('tools.edit does not exist');
  expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('fixture-source');
});

it('refuses to start a custom profile that lists bulk_read', async () => {
  const directory = temporaryDirectory('tau-bulk-read-profile-');
  mkdirSync(join(directory, 'agents'));

  writeFileSync(
    join(directory, 'agents', 'legacy.md'),
    '---\nname: legacy\nrole: investigation\ntools: read, bulk_read\n---\nInspect.\n',
  );

  const worker = await startProfileWorker(directory, 'legacy');

  expect(readEvent(worker.taskDirectory, worker.taskId, 'startupFailure')?.detail).toContain(
    'Worker profile tools are not registered: bulk_read.',
  );

  expect(readEvent(worker.taskDirectory, worker.taskId, 'ready')).toBeUndefined();
});

it.for([
  ['scout', true],
  ['qa', false],
] as const)(
  'adds the codemode guidelines to the %s worker prompt: %s',
  async ([profileName, expected]) => {
    const directory = temporaryDirectory('tau-worker-guidelines-');
    const worker = await startProfileWorker(directory, profileName);
    const { captured, step } = captureSystemPrompt();

    await runTask(worker, [step, ...stopWithoutReport]);

    expect(captured.systemPrompt).toContain('# Tau workflow instructions');
    expect(hasCodemodeGuidelines(captured.systemPrompt)).toBe(expected);
  },
);

it.for([
  [['read', 'codemode'], true],
  [['read'], false],
] as const)(
  'adds the codemode guidelines to a manager prompt with tools %j: %s',
  async ([tools, expected]) => {
    const directory = temporaryDirectory('tau-manager-guidelines-');
    vi.stubEnv('TAU_WORKER_RECORD', '');
    const provider = fauxProvider({ provider: 'tau-manager-guidelines' });
    const { captured, step } = captureSystemPrompt();

    const { session } = await createBoundSession(onTestFinished, {
      cwd: directory,
      agentDirectory: directory,
      providers: [provider],
      tools: [...tools],
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
      extensionFactories: [createCodemodeExtension({ mode: 'on' }), workflowExtension],
    });

    provider.setResponses([step]);
    await session.prompt('Check the fixture.');

    expect(captured.systemPrompt).toContain('# Tau workflow instructions');
    expect(hasCodemodeGuidelines(captured.systemPrompt)).toBe(expected);
  },
);
