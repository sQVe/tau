import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import type { Assignment } from '../src/extensions/subagents/assignment.js';
import { readAssignment } from '../src/extensions/subagents/assignment.js';
import { Admission, executeLaunch } from '../src/extensions/subagents/launch.js';
import type { LaunchRuntime } from '../src/extensions/subagents/launch.js';
import * as loadouts from '../src/extensions/subagents/loadout.js';
import { createReportDelivery } from '../src/extensions/subagents/reportDelivery.js';
import { runWithEnvironment } from '../src/hc/connect.js';
import { skillTools } from '../src/skillTools.js';
import { startHcSession } from './hcSessionHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface NoteObservation {
  path: string;
  report: boolean;
}

vi.mock(import('../src/extensions/subagents/loadout.js'), { spy: true });

vi.setConfig({ testTimeout: 120_000 });

const reportDeadlineMilliseconds = 90_000;
const reportPollMilliseconds = 100;

const waitForReport = async (path: string): Promise<Assignment> => {
  const deadline = Date.now() + reportDeadlineMilliseconds;

  let assignment = await readAssignment(path);

  while (assignment?.report == null) {
    if (Date.now() > deadline) {
      throw new Error(`Worker never wrote a report to ${path}.`);
    }

    await delay(reportPollMilliseconds);
    assignment = await readAssignment(path);
  }

  return assignment;
};

const waitForObservation = async (path: string): Promise<NoteObservation> => {
  const deadline = Date.now() + reportDeadlineMilliseconds;

  while (Date.now() <= deadline) {
    try {
      const [line] = readFileSync(path, 'utf8').trim().split('\n');

      if (line !== undefined && line !== '') {
        return JSON.parse(line) as NoteObservation;
      }
    } catch {
      // The manager has not recorded the note yet.
    }

    await delay(reportPollMilliseconds);
  }

  throw new Error(`Manager never observed the note at ${path}.`);
};

const managerProbe = `
import { appendFileSync, readFileSync } from 'node:fs';

const output = process.argv[2];
const marker = '[tau-report]';
let buffer = '';
let observed = false;

const observe = () => {
  if (observed) return;
  const at = buffer.indexOf(marker);
  if (at < 0) return;
  const match = buffer.slice(at + marker.length).match(/\\/\\S+/);
  if (match === null) return;
  const path = match[0].replace(/[^A-Za-z0-9/_.-].*$/s, '');
  let report = false;
  try {
    report = JSON.parse(readFileSync(path, 'utf8')).report != null;
  } catch {
    return;
  }
  appendFileSync(output, JSON.stringify({ path, report }) + '\\n');
  observed = true;
  process.exit(0);
};

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  observe();
});
`;

it('shows a real worker report once before it gives the worker the manager environment', async () => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  vi.stubEnv('HC_SESSION', hc.session);

  const controlledProviderPath = fileURLToPath(
    new URL('../src/extensions/subagents/fixtures/controlledProvider.ts', import.meta.url),
  );

  vi.resetModules();

  const { fixtureModel } =
    await import('../src/extensions/subagents/fixtures/controlledProvider.js');

  const agentDirectory = realpathSync(temporaryDirectory(onTestFinished, 'tau-report-agent-'));
  const workerDirectory = realpathSync(temporaryDirectory(onTestFinished, 'tau-report-worker-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  writeFileSync(join(workerDirectory, 'source.txt'), 'before\n');
  mkdirSync(join(workerDirectory, 'delete-fixture', '.git'), { recursive: true });
  writeFileSync(join(workerDirectory, 'delete-fixture', '.git', 'keep'), 'preserve');

  const appendMarker = `APPEND-MARKER-${randomBytes(6).toString('hex')}`;
  writeFileSync(join(agentDirectory, 'APPEND_SYSTEM.md'), `${appendMarker}\n`);

  const safetyPackage = dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json')));

  writeFileSync(
    join(agentDirectory, 'settings.json'),
    JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
      packages: [safetyPackage],
    }),
  );

  mkdirSync(join(agentDirectory, 'extensions'), { recursive: true });

  writeFileSync(
    join(agentDirectory, 'extensions', 'controlled-provider.js'),
    `export { default } from ${JSON.stringify(controlledProviderPath)};\n`,
  );

  const observationPath = join(workerDirectory, 'note-observation.jsonl');
  const probePath = join(agentDirectory, 'manager-probe.mjs');

  writeFileSync(probePath, managerProbe);

  const manager = await runWithEnvironment(hc.runtime, {
    argv: ['node', probePath, observationPath],
    name: 'manager',
    env: { PATH: process.env.PATH ?? '' },
  });

  vi.stubEnv('HC_TERMINAL_ID', manager.address);

  const managerPath = `${join(agentDirectory, 'bin')}:${process.env.PATH ?? ''}`;

  const loadout: Assignment['loadout'] = {
    harness: 'pi',
    profile: 'worker',
    role: 'editing',
    model: `${fixtureModel.provider}/${fixtureModel.id}`,
    thinking: 'off',
    cwd: workerDirectory,
    agentDirectory,
    permissions: 'trusted-full-tools',
    instructions: 'Follow the fixture task exactly.',
    tools: ['read', 'bash', 'edit', 'write'],
    skills: [],
    instructionSets: ['writing', 'coding', 'workflow'],
    packages: [],
  };

  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({ loadout, routing: undefined });

  const runtime: LaunchRuntime = {
    pi: { getCommands: () => [] } as unknown as ExtensionAPI,
    hc: hc.runtime,
    capacity: 4,
    admission: new Admission(),
    skillTools,
    agentDirectory,
    processEnvironment: { ...hc.environment, PATH: managerPath },
  };

  const result = await executeLaunch(
    runtime,
    {
      parameters: {
        task: 'Edit source.txt and report.',
        profile: 'worker',
        acceptance: ['source.txt says after.'],
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

  const assignment = await waitForReport(assignmentFilePath);
  const evidence = assignment.report?.evidence ?? [];
  const observation = await waitForObservation(observationPath);

  expect(observation.path).toBe(assignmentFilePath);
  expect(observation.report).toBe(true);

  expect(managerPath).not.toBe(hc.environment['PATH']);
  expect(evidence).toContain(`PATH: ${managerPath}`);
  expect(evidence).toContain(`PI_CODING_AGENT_DIR: ${agentDirectory}`);
  expect(evidence).toContain('TAU_ROLE: worker');
  expect(evidence).toContain('APPEND_SYSTEM.md: true');

  const messages: unknown[] = [];
  const entries: { type: string; customType: string; details?: unknown }[] = [];

  const pi = {
    sendMessage: (message: { customType: string; details: unknown }) => {
      messages.push(message);

      entries.push({
        type: 'custom_message',
        customType: message.customType,
        details: message.details,
      });
    },
  } as unknown as ExtensionAPI;

  const delivery = createReportDelivery(pi, hc.runtime);

  const deliveryContext = {
    sessionManager: { getEntries: () => entries },
    ui: { notify: () => undefined },
  } as unknown as Parameters<typeof delivery.deliver>[0];

  await delivery.deliver(deliveryContext);
  await delivery.deliver(deliveryContext);

  expect(messages).toHaveLength(1);
});
