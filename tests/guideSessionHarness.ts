import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';
import { expect, vi } from 'vitest';

import {
  assignmentDirectory,
  assignmentPath,
  writeAssignment,
} from '../src/extensions/subagents/assignment.js';
import type { Loadout } from '../src/extensions/subagents/types.js';
import workerExtension from '../src/extensions/subagents/workerExtension.js';
import { workerStartMessage } from '../src/extensions/subagents/workerStart.js';
import { workerTools } from '../src/extensions/subagents/workerTools.js';
import { skillTools } from '../src/skillTools.js';
import { createHcFake } from './hcFake.js';
import { createPiSession } from './piSession.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface PromptSession {
  run: () => Promise<string>;
  notices: string[];
}

interface WorkerRun {
  prompt: string;
  notices: string[];
}

interface WorkerLoadoutOptions {
  cwd: string;
  agentDirectory: string;
  model: string;
  instructionSets: Loadout['instructionSets'];
}

const instructionsExtensionPath = fileURLToPath(
  new URL('../src/extensions/instructions.ts', import.meta.url),
);

export const bundleDirectory = fileURLToPath(new URL('../vendor/stomme', import.meta.url));

const safetyExtensionPath = join(
  dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
  'dist',
  'pi',
  'index.js',
);

// Pi-claude-bridge reads the append section at agent_start, after every handler has run.
const captureAppendSection = (appended: string[]) => (pi: ExtensionAPI) => {
  let options: { appendSystemPrompt?: string } = {};

  pi.on('before_agent_start', (event) => {
    options = event.systemPromptOptions;
  });

  pi.on('agent_start', () => {
    appended.push(options.appendSystemPrompt ?? '');
  });
};

export const startMainSession = async (
  onTestFinished: TestContext['onTestFinished'],
  cwd: string,
): Promise<PromptSession> => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('TAU_ROLE', undefined);
  vi.stubEnv('TAU_WORKER_RECORD', undefined);

  const provider = fauxProvider({ provider: 'tau-guides-main' });
  const appended: string[] = [];
  const notices: string[] = [];

  const { session, extensionsResult } = await createPiSession(onTestFinished, {
    cwd,
    agentDirectory: join(cwd, '.agent'),
    providers: [provider],
    extensionPaths: [instructionsExtensionPath],
    extensionFactories: [captureAppendSection(appended)],
  });

  expect(extensionsResult.errors).toEqual([]);

  await session.bindExtensions({
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: (message: string, type?: string) => {
        notices.push(`${type ?? 'info'}: ${message}`);
      },
    },
  });

  return {
    notices,
    run: async () => {
      provider.setResponses([fauxAssistantMessage('Ready.')]);
      await session.prompt('Run.');

      return appended.at(-1) ?? '';
    },
  };
};

const workerLoadout = ({
  cwd,
  agentDirectory,
  model,
  instructionSets,
}: WorkerLoadoutOptions): Loadout => ({
  harness: 'pi',
  profile: 'worker',
  role: 'investigation',
  model,
  thinking: 'off',
  cwd,
  agentDirectory,
  permissions: 'trusted-full-tools',
  instructions: 'Work on the assigned task.',
  tools: ['read', 'bash'],
  skills: [],
  instructionSets,
  packages: [],
});

export const runWorker = async (
  onTestFinished: TestContext['onTestFinished'],
  cwd: string,
  instructionSets: Loadout['instructionSets'],
): Promise<WorkerRun> => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-guides-agent-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('TAU_ROLE', 'worker');
  vi.stubEnv('HC_TERMINAL_ID', 'worker');

  const provider = fauxProvider({ provider: 'tau-guides-worker' });
  const model = provider.getModel();

  const loadout = workerLoadout({
    cwd,
    agentDirectory,
    model: `${model.provider}/${model.id}`,
    instructionSets,
  });

  const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';
  const sessionId = '11111111-1111-1111-1111-111111111111';
  const sessionFile = join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`);

  await writeAssignment({
    version: 3,
    assignmentId,
    task: 'Inspect the project.',
    acceptance: [],
    label: null,
    profile: 'worker',
    loadout,
    routing: null,
    packageSnapshot: null,
    session: { id: sessionId, file: sessionFile },
    parentSession: join(agentDirectory, 'parent.jsonl'),
    cwd,
    parentTerminal: 'manager',
    deadline: Date.now() + 30_000,
    createdAt: Date.now(),
    previousAssignmentId: null,
    extensionPackages: null,
    questions: [],
    report: null,
  });

  const hc = createHcFake();

  hc.reply(
    'get',
    JSON.stringify({
      address: 'worker',
      state: 'live',
      parent: 'manager',
      labels: { 'tau.assignment': assignmentPath(assignmentId) },
    }),
  );

  const appended: string[] = [];

  const { session, extensionsResult } = await createPiSession(onTestFinished, {
    cwd,
    agentDirectory,
    providers: [provider],
    tools: workerTools(loadout, skillTools),
    sessionManager: SessionManager.open(sessionFile),
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    extensionPaths: [safetyExtensionPath],
    extensionFactories: [
      (pi) => {
        pi.exec = hc.exec;

        workerExtension(pi);
      },
      captureAppendSection(appended),
    ],
  });

  expect(extensionsResult.errors).toEqual([]);

  const notices: string[] = [];

  provider.setResponses([0, 1, 2].map(() => fauxAssistantMessage('Ready.')));

  await session.bindExtensions({
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: (message: string) => {
        notices.push(message);
      },
    },
  });

  await session.prompt(workerStartMessage);

  return { prompt: appended[0] ?? '', notices };
};

export const bundleGuide = async (path: string): Promise<string> =>
  (await readFile(join(bundleDirectory, path), 'utf8')).trim();
