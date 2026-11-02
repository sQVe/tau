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
import { createWorkerDelivery } from '../src/extensions/subagents/workerDelivery.js';
import { runWithEnvironment } from '../src/hc/connect.js';
import { ls, send } from '../src/hc/hc.js';
import { installCommandShim } from './commandShimFake.js';
import { startHcSession } from './hcSessionHarness.js';
import type { HcSession } from './hcSessionHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface NoteObservation {
  path: string;
}

interface SentMessage {
  customType?: unknown;
  content?: unknown;
  details?: unknown;
}

interface SessionEntry {
  type: string;
  customType?: string;
  details?: unknown;
}

type DeliveryContext = Parameters<ReturnType<typeof createWorkerDelivery>['deliver']>[0];

interface ManagerProbe {
  source: string;
}

interface FixtureWorker {
  agentDirectory: string;
  managerAddress: string;
  assignmentFilePath: string;
  observationPath: string | undefined;
}

vi.mock(import('../src/extensions/subagents/loadout.js'), { spy: true });

vi.setConfig({ testTimeout: 120_000 });

const noteDeadlineMilliseconds = 90_000;
const pollMilliseconds = 100;

const waitForQuestion = async (path: string): Promise<Assignment> => {
  const deadline = Date.now() + noteDeadlineMilliseconds;

  let assignment = await readAssignment(path);

  while (assignment === undefined || assignment.questions.length === 0) {
    if (Date.now() > deadline) {
      throw new Error(`Worker never saved a question to ${path}.`);
    }

    await delay(pollMilliseconds);
    assignment = await readAssignment(path);
  }

  return assignment;
};

const waitForReport = async (path: string): Promise<Assignment> => {
  const deadline = Date.now() + noteDeadlineMilliseconds;

  let assignment = await readAssignment(path);

  while (assignment?.report == null) {
    if (Date.now() > deadline) {
      throw new Error(`Worker never wrote a report to ${path}.`);
    }

    await delay(pollMilliseconds);
    assignment = await readAssignment(path);
  }

  return assignment;
};

const waitForObservation = async (path: string): Promise<NoteObservation> => {
  const deadline = Date.now() + noteDeadlineMilliseconds;

  while (Date.now() <= deadline) {
    try {
      const [line] = readFileSync(path, 'utf8').trim().split('\n');

      if (line !== undefined && line !== '') {
        return JSON.parse(line) as NoteObservation;
      }
    } catch {
      // The manager has not recorded the note yet.
    }

    await delay(pollMilliseconds);
  }

  throw new Error(`Manager never observed the note at ${path}.`);
};

const managerQuestionProbe = `
import { appendFileSync } from 'node:fs';

const output = process.argv[2];
const marker = '[tau-question]';
let buffer = '';
let observed = false;

const observe = () => {
  if (observed) return;
  const at = buffer.indexOf(marker);
  if (at < 0) return;
  const match = buffer.slice(at + marker.length).match(/\\/\\S+/);
  if (match === null) return;
  const path = match[0].replace(/[^A-Za-z0-9/_.-].*$/s, '');
  appendFileSync(output, JSON.stringify({ path }) + '\\n');
  observed = true;
};

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  observe();
});
`;

const childAddress = async (hc: HcSession, parent: string): Promise<string> => {
  const list = await ls(hc.runtime, { all: true });
  const child = list.terminals.find((terminal) => terminal.parent === parent);

  if (child === undefined) {
    throw new Error(`No worker terminal under ${parent}.`);
  }

  return child.address;
};

const recordingExtension = (messages: SentMessage[], entries: SessionEntry[]): ExtensionAPI =>
  ({
    sendMessage: (message: SentMessage) => {
      messages.push(message);

      entries.push({
        type: 'custom_message',
        ...(typeof message.customType === 'string' ? { customType: message.customType } : {}),
        details: message.details,
      });
    },
  }) as unknown as ExtensionAPI;

const deliveryContext = (entries: SessionEntry[]): DeliveryContext =>
  ({
    sessionManager: { getEntries: () => entries },
    ui: { notify: () => undefined },
  }) as unknown as DeliveryContext;

const launchFixtureWorker = async (options: {
  hc: HcSession;
  model: { provider: string; id: string };
  task: string;
  probe?: ManagerProbe;
}): Promise<FixtureWorker> => {
  const agentDirectory = realpathSync(temporaryDirectory(onTestFinished, 'tau-question-agent-'));
  const workerDirectory = realpathSync(temporaryDirectory(onTestFinished, 'tau-question-worker-'));

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

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

  const controlledProviderPath = fileURLToPath(
    new URL('../src/extensions/subagents/fixtures/controlledProvider.ts', import.meta.url),
  );

  writeFileSync(
    join(agentDirectory, 'extensions', 'controlled-provider.js'),
    `export { default } from ${JSON.stringify(controlledProviderPath)};\n`,
  );

  const probePath =
    options.probe === undefined ? undefined : join(agentDirectory, 'manager-probe.mjs');

  const observationPath =
    options.probe === undefined ? undefined : join(agentDirectory, 'manager-observation.jsonl');

  if (options.probe !== undefined && probePath !== undefined) {
    writeFileSync(probePath, options.probe.source);
  }

  const managerArgv =
    probePath === undefined || observationPath === undefined
      ? ['sleep', '60']
      : ['node', probePath, observationPath];

  const manager = await runWithEnvironment(options.hc.runtime, {
    argv: managerArgv,
    name: 'manager',
    env: { PATH: process.env.PATH ?? '' },
  });

  vi.stubEnv('HC_TERMINAL_ID', manager.address);

  const managerPath = `${join(agentDirectory, 'bin')}:${process.env.PATH ?? ''}`;

  const loadout: Assignment['loadout'] = {
    harness: 'pi',
    profile: 'worker',
    role: 'editing',
    model: `${options.model.provider}/${options.model.id}`,
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
        acceptance: ['Report the answer.'],
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
    assignmentFilePath,
    observationPath,
  };
};

it('shows a real worker question once and carries the manager answer into its report', async () => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  vi.stubEnv('HC_SESSION', hc.session);

  vi.resetModules();

  const { fixtureModel, questionTaskMarker } =
    await import('../src/extensions/subagents/fixtures/controlledProvider.js');

  const worker = await launchFixtureWorker({
    hc,
    model: fixtureModel,
    task: `${questionTaskMarker} Ask which value the report should hold.`,
    probe: { source: managerQuestionProbe },
  });

  const assignment = await waitForQuestion(worker.assignmentFilePath);

  if (worker.observationPath === undefined) {
    throw new Error('The fixture worker got no manager probe.');
  }

  const observation = await waitForObservation(worker.observationPath);
  const question = assignment.questions[0];

  if (question === undefined) {
    throw new Error('Worker saved no question.');
  }

  expect(observation.path).toBe(worker.assignmentFilePath);

  const messages: SentMessage[] = [];
  const entries: SessionEntry[] = [];
  const pi = recordingExtension(messages, entries);
  const context = deliveryContext(entries);

  const delivery = createWorkerDelivery(pi, hc.runtime);

  await delivery.deliver(context);
  await delivery.deliver(context);

  expect(messages).toHaveLength(1);

  await createWorkerDelivery(pi, hc.runtime).deliver(context);

  expect(messages).toHaveLength(1);

  const questionMessage = messages[0];

  expect(questionMessage?.content).toContain(question.text);

  expect(questionMessage?.details).toEqual({
    assignmentId: assignment.assignmentId,
    questionId: question.questionId,
  });

  const workerAddress = await childAddress(hc, worker.managerAddress);

  expect(questionMessage?.content).toContain(`hc send ${workerAddress} "<answer>"`);

  const reply = `manager-reply-${randomBytes(6).toString('hex')}`;

  await send(hc.runtime, workerAddress, { text: reply });

  const reported = await waitForReport(worker.assignmentFilePath);

  expect(reported.report?.evidence).toContain(reply);
});

it('shows a question once in a fresh delivery after its note failed', async () => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  vi.stubEnv('HC_SESSION', hc.session);

  await installCommandShim('hc', {
    otherCalls: 'real',
    overrides: [{ match: ' send ', script: `printf '%s\\n' 'send refused' >&2; exit 1` }],
  });

  vi.resetModules();

  const { fixtureModel, questionTaskMarker } =
    await import('../src/extensions/subagents/fixtures/controlledProvider.js');

  const worker = await launchFixtureWorker({
    hc,
    model: fixtureModel,
    task: `${questionTaskMarker} Ask which value the report should hold.`,
  });

  const assignment = await waitForQuestion(worker.assignmentFilePath);
  const question = assignment.questions[0];

  if (question === undefined) {
    throw new Error('Worker saved no question.');
  }

  const messages: SentMessage[] = [];
  const entries: SessionEntry[] = [];
  const pi = recordingExtension(messages, entries);
  const context = deliveryContext(entries);

  await createWorkerDelivery(pi, hc.runtime).deliver(context);

  expect(messages).toHaveLength(1);

  expect(messages[0]?.details).toEqual({
    assignmentId: assignment.assignmentId,
    questionId: question.questionId,
  });

  await createWorkerDelivery(pi, hc.runtime).deliver(context);

  expect(messages).toHaveLength(1);
});
