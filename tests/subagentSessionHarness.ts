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
import { workerCommand } from '../src/extensions/subagents/workerCommand.js';
import { runWithEnvironment } from '../src/hc/connect.js';
import { get } from '../src/hc/hc.js';
import { skillTools } from '../src/skillTools.js';
import { initializeRepository } from './gitRepository.js';
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
  tauPackage?: boolean;
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

// What a wait needs to read the assignment and notice that the worker ended first.
export interface ObservedWorker {
  assignmentFilePath: string;
  workerAddress: string;
  runtime: LaunchRuntime;
}

// Launches record this parent session, so a fake manager context must return it from getSessionFile.
export const managerSessionFile = '/sessions/manager.jsonl';

const observationDeadlineMilliseconds = 90_000;
const observationPollMilliseconds = 100;
// hc runs one command per terminal check, so the worker is checked once per second, not per poll.
const pollsPerTerminalCheck = 10;

// A worker saves its report and then exits, so a finished terminal only means the wait failed when
// the assignment still lacks what the wait asks for after one more read.
const throwIfWorkerEnded = async (
  worker: ObservedWorker,
  isDone: (assignment: Assignment | undefined) => assignment is Assignment,
): Promise<void> => {
  const terminal = await get(worker.runtime.hc, worker.workerAddress);

  if (terminal.state !== 'finished') {
    return;
  }

  if (isDone(await readAssignment(worker.assignmentFilePath))) {
    return;
  }

  const exitCode = String(terminal.exit_code ?? 'unknown');

  throw new Error(
    `Worker terminal ${worker.workerAddress} ended (exit code ${exitCode}) before it saved a report or a question to ${worker.assignmentFilePath}.`,
  );
};

const waitForAssignment = async (
  worker: ObservedWorker,
  isDone: (assignment: Assignment | undefined) => assignment is Assignment,
  missingMessage: string,
): Promise<Assignment> => {
  const deadline = Date.now() + observationDeadlineMilliseconds;

  let assignment = await readAssignment(worker.assignmentFilePath);
  let polls = 0;

  while (!isDone(assignment)) {
    if (Date.now() > deadline) {
      throw new Error(missingMessage);
    }

    if (polls % pollsPerTerminalCheck === 0) {
      await throwIfWorkerEnded(worker, isDone);
    }

    polls += 1;

    await delay(observationPollMilliseconds);
    assignment = await readAssignment(worker.assignmentFilePath);
  }

  return assignment;
};

export const waitForReport = async (worker: ObservedWorker): Promise<Assignment> =>
  waitForAssignment(
    worker,
    (assignment): assignment is Assignment => assignment?.report != null,
    `Worker never wrote a report to ${worker.assignmentFilePath}.`,
  );

export const waitForQuestion = async (worker: ObservedWorker): Promise<Assignment> =>
  waitForAssignment(
    worker,
    (assignment): assignment is Assignment =>
      assignment !== undefined && assignment.questions.length > 0,
    `Worker never saved a question to ${worker.assignmentFilePath}.`,
  );

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

const writeFixtureProfile = (
  agentDirectory: string,
  model: { provider: string; id: string },
): void => {
  mkdirSync(join(agentDirectory, 'agents'), { recursive: true });

  writeFileSync(
    join(agentDirectory, 'agents', 'worker.md'),
    [
      '---',
      'name: worker',
      'role: editing',
      'tools: read, bash, edit, write',
      'thinking: off',
      '---',
      '',
      'Follow the fixture task exactly.',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(agentDirectory, 'tau.json'),
    JSON.stringify({ profiles: { worker: { model: `${model.provider}/${model.id}` } } }),
  );
};

const launchContext = (
  model: { provider: string; id: string },
  workerDirectory: string,
): ExtensionContext =>
  ({
    sessionManager: { getSessionId: () => 'manager-one' },
    cwd: workerDirectory,
    isProjectTrusted: () => true,
    scopedModels: [],
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
    },
    ui: { notify: () => undefined },
  }) as unknown as ExtensionContext;

// hc kills a worker when its parent terminal ends, so the manager fixture must outlive the test.
const managerIdleProgram = ['node', '-e', 'setInterval(() => undefined, 60_000);'];

const managerInvocation = (
  agentDirectory: string,
  probe: { source: string } | undefined,
): { argv: string[]; observationPath: string | undefined } => {
  if (probe === undefined) {
    return { argv: managerIdleProgram, observationPath: undefined };
  }

  const probePath = join(agentDirectory, 'manager-probe.mjs');
  const observationPath = join(agentDirectory, 'manager-observation.jsonl');

  writeFileSync(probePath, probe.source);

  return { argv: ['node', probePath, observationPath], observationPath };
};

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

const tauPackageCommand: NonNullable<LaunchRuntime['buildCommand']> = (sessionFile, loadout) =>
  workerCommand(sessionFile, loadout, [{ path: packageRoot }], skillTools);

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

  options.prepareWorker?.(workerDirectory);

  await initializeRepository(workerDirectory);
  writeFileSync(join(workerDirectory, '.gitignore'), '.tau/\n');
  mkdirSync(join(workerDirectory, '.pi'), { recursive: true });

  writeFileSync(
    join(workerDirectory, '.pi', 'tau.json'),
    JSON.stringify({ fullCheck: { argv: ['node', '-e', 'process.exit(0)'] } }),
  );

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

  writeFixtureProfile(agentDirectory, options.model);

  const runtime: LaunchRuntime = {
    pi: { getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI,
    hc: options.hc.runtime,
    capacity: 4,
    admission: new Admission(),
    readSkillTools: () => ({}),
    agentDirectory,
    processEnvironment: { ...options.hc.environment, PATH: managerPath },
    ...(workerArgv === undefined ? {} : { buildCommand: () => workerArgv }),
    ...(options.tauPackage === true ? { buildCommand: tauPackageCommand } : {}),
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
    launchContext(options.model, workerDirectory),
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
): Promise<ObservedWorker> => {
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

  return { assignmentFilePath, workerAddress, runtime: source.runtime };
};
