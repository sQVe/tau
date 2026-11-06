import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, onTestFinished, vi } from 'vitest';

import type { Assignment } from '../src/extensions/subagents/assignment.js';
import { readAssignment } from '../src/extensions/subagents/assignment.js';
import { executeFollowUp } from '../src/extensions/subagents/followUp.js';
import { Admission, executeLaunch } from '../src/extensions/subagents/launch.js';
import type { LaunchRuntime } from '../src/extensions/subagents/launch.js';
import * as loadouts from '../src/extensions/subagents/loadout.js';
import { runWithEnvironment } from '../src/hc/connect.js';
import { get } from '../src/hc/hc.js';
import type { HcSession } from './hcSessionHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

export interface WorkerSessionOptions {
  hc: HcSession;
  model: { provider: string; id: string };
  task: string;
  acceptance: string[];
  probe?: { source: string };
  command?: { source: string };
  timeoutSeconds?: number;
  prepareWorker?: (workerDirectory: string) => void;
  // Loads the inbox extension in the worker, as Tau's package does outside tests.
  inbox?: boolean;
  // Runs after the manager terminal exists and HC_TERMINAL_ID points at it, before the worker.
  beforeLaunch?: (managerAddress: string) => Promise<void>;
}

export interface WorkerSession {
  agentDirectory: string;
  managerAddress: string;
  managerPath: string;
  assignmentFilePath: string;
  workerAddress: string;
  runtime: LaunchRuntime;
  observationPath: string | undefined;
}

export interface FollowUpWorkerOptions {
  source: WorkerSession;
  task: string;
  acceptance?: string[];
  label?: string;
  timeoutSeconds?: number;
}

export interface FollowUpWorkerSession {
  assignmentFilePath: string;
  workerAddress: string;
}

// Launches record this parent session, so a fake manager context must return it from getSessionFile.
export const managerSessionFile = '/sessions/manager.jsonl';

const observationDeadlineMilliseconds = 90_000;
const observationPollMilliseconds = 100;

export const waitForReport = async (path: string): Promise<Assignment> => {
  const deadline = Date.now() + observationDeadlineMilliseconds;

  let assignment = await readAssignment(path);

  while (assignment?.report == null) {
    if (Date.now() > deadline) {
      throw new Error(`Worker never wrote a report to ${path}.`);
    }

    await delay(observationPollMilliseconds);
    assignment = await readAssignment(path);
  }

  return assignment;
};

const writeAgentSettings = (agentDirectory: string): void => {
  const safetyPackage = dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json')));

  writeFileSync(
    join(agentDirectory, 'settings.json'),
    JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
      packages: [safetyPackage],
    }),
  );
};

const writeControlledProvider = (agentDirectory: string): void => {
  const controlledProviderPath = fileURLToPath(
    new URL('../src/extensions/subagents/fixtures/controlledProvider.ts', import.meta.url),
  );

  mkdirSync(join(agentDirectory, 'extensions'), { recursive: true });

  writeFileSync(
    join(agentDirectory, 'extensions', 'controlled-provider.js'),
    `export { default } from ${JSON.stringify(controlledProviderPath)};\n`,
  );
};

const writeInboxExtension = (agentDirectory: string): void => {
  const inboxPath = fileURLToPath(new URL('../src/extensions/inbox/inbox.ts', import.meta.url));

  writeFileSync(
    join(agentDirectory, 'extensions', 'inbox.js'),
    `export { default } from ${JSON.stringify(inboxPath)};\n`,
  );
};

const managerInvocation = (
  agentDirectory: string,
  probe: { source: string } | undefined,
): { argv: string[]; observationPath: string | undefined } => {
  if (probe === undefined) {
    return { argv: ['sleep', '60'], observationPath: undefined };
  }

  const probePath = join(agentDirectory, 'manager-probe.mjs');
  const observationPath = join(agentDirectory, 'manager-observation.jsonl');

  writeFileSync(probePath, probe.source);

  return { argv: ['node', probePath, observationPath], observationPath };
};

const workerCommandArgv = (
  agentDirectory: string,
  command: { source: string } | undefined,
): string[] | undefined => {
  if (command === undefined) {
    return undefined;
  }

  const commandPath = join(agentDirectory, 'worker-program.mjs');

  writeFileSync(commandPath, command.source);

  return ['node', commandPath, agentDirectory];
};

const fixtureLoadout = (
  workerDirectory: string,
  agentDirectory: string,
  model: { provider: string; id: string },
): Assignment['loadout'] => ({
  harness: 'pi',
  profile: 'worker',
  role: 'editing',
  model: `${model.provider}/${model.id}`,
  thinking: 'off',
  cwd: workerDirectory,
  agentDirectory,
  permissions: 'trusted-full-tools',
  instructions: 'Follow the fixture task exactly.',
  tools: ['read', 'bash', 'edit', 'write'],
  skills: [],
  instructionSets: ['writing', 'coding', 'workflow'],
  packages: [],
});

export const launchWorkerSession = async (
  options: WorkerSessionOptions,
): Promise<WorkerSession> => {
  const agentDirectory = realpathSync(temporaryDirectory(onTestFinished, 'tau-worker-agent-'));
  const workerDirectory = realpathSync(temporaryDirectory(onTestFinished, 'tau-worker-'));

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const appendMarker = `APPEND-MARKER-${randomBytes(6).toString('hex')}`;
  writeFileSync(join(agentDirectory, 'APPEND_SYSTEM.md'), `${appendMarker}\n`);

  writeAgentSettings(agentDirectory);
  writeControlledProvider(agentDirectory);

  if (options.inbox === true) {
    writeInboxExtension(agentDirectory);
  }

  options.prepareWorker?.(workerDirectory);

  const { argv: managerArgv, observationPath } = managerInvocation(agentDirectory, options.probe);
  const workerArgv = workerCommandArgv(agentDirectory, options.command);

  const manager = await runWithEnvironment(options.hc.runtime, {
    argv: managerArgv,
    name: 'manager',
    env: { PATH: process.env.PATH ?? '' },
  });

  vi.stubEnv('HC_TERMINAL_ID', manager.address);

  await options.beforeLaunch?.(manager.address);

  const managerPath = `${join(agentDirectory, 'bin')}:${process.env.PATH ?? ''}`;
  const loadout = fixtureLoadout(workerDirectory, agentDirectory, options.model);

  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({
    loadout,
    routing: undefined,
    choice: { kind: 'profileWithoutRoute' },
  });

  const runtime: LaunchRuntime = {
    pi: { getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI,
    hc: options.hc.runtime,
    capacity: 4,
    admission: new Admission(),
    readSkillTools: () => ({}),
    agentDirectory,
    processEnvironment: { ...options.hc.environment, PATH: managerPath },
    ...(workerArgv === undefined ? {} : { buildCommand: () => workerArgv }),
  };

  const result = await executeLaunch(
    runtime,
    {
      parameters: {
        task: options.task,
        profile: 'worker',
        acceptance: options.acceptance,
        ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
      },
      startedAt: { wall: Date.now(), monotonic: performance.now() },
      parentSession: managerSessionFile,
    },
    undefined,
    { sessionManager: { getSessionId: () => 'manager-one' } } as unknown as ExtensionContext,
  );

  expect(result.isError).not.toBe(true);

  const assignmentFilePath = result.details?.labels['tau.assignment'];
  const workerAddress = result.details?.address;

  if (assignmentFilePath === undefined || workerAddress === undefined) {
    throw new Error('Launch returned no assignment label or address.');
  }

  return {
    agentDirectory,
    managerAddress: manager.address,
    managerPath,
    assignmentFilePath,
    workerAddress,
    runtime,
    observationPath,
  };
};

export const waitForTerminalFinished = async (hc: HcSession, address: string): Promise<void> => {
  const deadline = Date.now() + observationDeadlineMilliseconds;

  while (Date.now() <= deadline) {
    const terminal = await get(hc.runtime, address);

    if (terminal.state === 'finished') {
      return;
    }

    await delay(observationPollMilliseconds);
  }

  throw new Error(`Worker terminal ${address} never finished.`);
};

export const followUpWorkerSession = async (
  options: FollowUpWorkerOptions,
): Promise<FollowUpWorkerSession> => {
  const { source } = options;
  const sourceAssignment = await readAssignment(source.assignmentFilePath);

  if (sourceAssignment === undefined) {
    throw new Error(`The source assignment is missing: ${source.assignmentFilePath}.`);
  }

  vi.stubEnv('HC_TERMINAL_ID', source.managerAddress);
  vi.stubEnv('PI_CODING_AGENT_DIR', source.agentDirectory);

  const result = await executeFollowUp(
    source.runtime,
    {
      parameters: {
        sourceAssignmentId: sourceAssignment.assignmentId,
        task: options.task,
        ...(options.acceptance === undefined ? {} : { acceptance: options.acceptance }),
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
      },
      startedAt: { wall: Date.now(), monotonic: performance.now() },
      parentSession: managerSessionFile,
    },
    undefined,
    { sessionManager: { getSessionId: () => 'manager-one' } } as unknown as ExtensionContext,
  );

  expect(result.isError).not.toBe(true);

  const assignmentFilePath = result.details?.labels['tau.assignment'];
  const workerAddress = result.details?.address;

  if (assignmentFilePath === undefined || workerAddress === undefined) {
    throw new Error('The follow-up returned no assignment label or address.');
  }

  return { assignmentFilePath, workerAddress };
};
