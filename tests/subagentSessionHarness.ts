import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, onTestFinished, vi } from 'vitest';

import type { Assignment } from '../src/extensions/subagents/assignment.js';
import { readAssignment } from '../src/extensions/subagents/assignment.js';
import { Admission, executeLaunch } from '../src/extensions/subagents/launch.js';
import type { LaunchRuntime } from '../src/extensions/subagents/launch.js';
import * as loadouts from '../src/extensions/subagents/loadout.js';
import { runWithEnvironment } from '../src/hc/connect.js';
import type { HcSession } from './hcSessionHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface NoteObservation {
  path: string;
  report: boolean;
}

export interface WorkerSessionOptions {
  hc: HcSession;
  model: { provider: string; id: string };
  task: string;
  acceptance: string[];
  probe?: { source: string };
  prepareWorker?: (workerDirectory: string) => void;
}

export interface WorkerSession {
  agentDirectory: string;
  managerAddress: string;
  managerPath: string;
  assignmentFilePath: string;
  observationPath: string | undefined;
}

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

export const waitForObservation = async (path: string): Promise<NoteObservation> => {
  const deadline = Date.now() + observationDeadlineMilliseconds;

  while (Date.now() <= deadline) {
    try {
      const [line] = readFileSync(path, 'utf8').trim().split('\n');

      if (line !== undefined && line !== '') {
        return JSON.parse(line) as NoteObservation;
      }
    } catch {
      // The manager has not recorded the note yet.
    }

    await delay(observationPollMilliseconds);
  }

  throw new Error(`Manager never observed the note at ${path}.`);
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

  options.prepareWorker?.(workerDirectory);

  const { argv: managerArgv, observationPath } = managerInvocation(agentDirectory, options.probe);

  const manager = await runWithEnvironment(options.hc.runtime, {
    argv: managerArgv,
    name: 'manager',
    env: { PATH: process.env.PATH ?? '' },
  });

  vi.stubEnv('HC_TERMINAL_ID', manager.address);

  const managerPath = `${join(agentDirectory, 'bin')}:${process.env.PATH ?? ''}`;
  const loadout = fixtureLoadout(workerDirectory, agentDirectory, options.model);

  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({ loadout, routing: undefined });

  const runtime: LaunchRuntime = {
    pi: { getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI,
    hc: options.hc.runtime,
    capacity: 4,
    admission: new Admission(),
    readSkillTools: () => ({}),
    agentDirectory,
    processEnvironment: { ...options.hc.environment, PATH: managerPath },
  };

  const result = await executeLaunch(
    runtime,
    {
      parameters: {
        task: options.task,
        profile: 'worker',
        acceptance: options.acceptance,
        visibility: 'background',
      },
      startedAt: { wall: Date.now(), monotonic: performance.now() },
      parentSession: join(agentDirectory, 'parent.jsonl'),
    },
    undefined,
    { sessionManager: { getSessionId: () => 'manager-one' } } as unknown as ExtensionContext,
  );

  expect(result.isError).not.toBe(true);

  const assignmentFilePath = result.details?.labels['tau.assignment'];

  if (assignmentFilePath === undefined) {
    throw new Error('Launch returned no assignment label.');
  }

  return {
    agentDirectory,
    managerAddress: manager.address,
    managerPath,
    assignmentFilePath,
    observationPath,
  };
};
