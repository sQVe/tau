import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import {
  assignmentDirectory,
  assignmentPath,
  checkoutFolder,
  readAssignment,
  writeAssignment,
} from './assignment.js';
import type { Assignment } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { executeFollowUp } from './followUp.js';
import { Admission } from './launch.js';
import type { LaunchRuntime } from './launch.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const manager = 't-manager';

const context = {
  sessionManager: { getSessionId: () => 'manager-one' },
} as unknown as ExtensionContext;

const terminalRun = (fake: HcFake) => {
  for (const call of fake.connectCalls) {
    const request = call.find((message) => message.method === 'terminal.run');

    if (request !== undefined) {
      return request.params as { labels: Record<string, string> };
    }
  }

  return undefined;
};

const assignmentFolders = (directory: string): string[] => {
  const root = join(directory, 'tau', checkoutFolder, 'assignments');

  return existsSync(root) ? readdirSync(root) : [];
};

const sourceAssignment = (directory: string, overrides: Partial<Assignment> = {}): Assignment => {
  const assignmentId = randomUUID();
  const sessionId = randomUUID();

  return {
    version: 3,
    assignmentId,
    task: 'Inspect the counters.',
    acceptance: ['The counters are inspected.'],
    label: null,
    profile: 'worker',
    loadout: fixtureLoadout(directory),
    routing: null,
    packageSnapshot: null,
    session: { id: sessionId, file: join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`) },
    parentSession: '/work/parent.jsonl',
    cwd: directory,
    parentTerminal: 't-old-manager',
    deadline: Date.now() + 30_000,
    createdAt: Date.now(),
    previousAssignmentId: null,
    extensionPackages: [],
    questions: [],
    report: null,
    ...overrides,
  };
};

const setup = (): { directory: string; fake: HcFake; runtime: LaunchRuntime } => {
  const directory = temporaryDirectory(onTestFinished, 'tau-followup-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fake = createHcFake();

  fake.reply('ls', JSON.stringify({ terminals: [] }));

  const runtime: LaunchRuntime = {
    pi: { getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI,
    hc: { exec: fake.exec, connect: fake.connect, cwd: directory },
    capacity: 4,
    admission: new Admission(),
    readSkillTools: () => ({}),
    agentDirectory: directory,
    processEnvironment: { PATH: process.env.PATH },
    buildCommand: () => ['sleep', '60'],
  };

  return { directory, fake, runtime };
};

const followUp = (
  runtime: LaunchRuntime,
  sourceAssignmentId: string,
  overrides: Record<string, unknown> = {},
) =>
  executeFollowUp(
    runtime,
    {
      parameters: {
        sourceAssignmentId,
        task: 'Continue the work.',
        acceptance: ['The follow-up is done.'],
        visibility: 'background',
        ...overrides,
      },
      startedAt: { wall: 1000, monotonic: 2 },
      parentSession: '/work/parent.jsonl',
    },
    undefined,
    context,
  );

const refusalCases: {
  name: string;
  prepare: (directory: string) => Promise<string>;
  overrides?: Record<string, unknown>;
}[] = [
  { name: 'missing source', prepare: () => Promise.resolve(randomUUID()) },
  {
    name: 'malformed source',
    prepare: async () => {
      const id = randomUUID();

      mkdirSync(assignmentDirectory(id), { recursive: true });
      writeFileSync(assignmentPath(id), 'not json');

      return id;
    },
  },
  {
    name: 'parent session mismatch',
    prepare: async (directory) => {
      const source = sourceAssignment(directory, { parentSession: join(directory, 'other.jsonl') });

      await writeAssignment(source);

      return source.assignmentId;
    },
  },
  {
    name: 'acceptance refusal',
    prepare: async (directory) => {
      const source = sourceAssignment(directory);

      await writeAssignment(source);

      return source.assignmentId;
    },
    overrides: { acceptance: undefined },
  },
  {
    name: 'missing session file',
    prepare: async (directory) => {
      const source = sourceAssignment(directory);

      await writeAssignment(source);
      rmSync(source.session.file);

      return source.assignmentId;
    },
  },
  {
    name: 'missing package path',
    prepare: async (directory) => {
      const source = sourceAssignment(directory, {
        extensionPackages: [{ source: 'pkg', path: join(directory, 'missing-extension.js') }],
      });

      await writeAssignment(source);

      return source.assignmentId;
    },
  },
  {
    name: 'null packages with profile packages',
    prepare: async (directory) => {
      const source = sourceAssignment(directory, { extensionPackages: null });
      const loadout = { ...source.loadout, packages: ['npm:some-package'] };

      await writeAssignment({ ...source, loadout });

      return source.assignmentId;
    },
  },
];

it.each(refusalCases)('refuses a follow-up with a $name', async ({ prepare, overrides }) => {
  const { directory, fake, runtime } = setup();
  const sourceId = await prepare(directory);
  const before = assignmentFolders(directory);

  const result = await followUp(runtime, sourceId, overrides);

  expect(result.isError).toBe(true);
  expect(terminalRun(fake)).toBeUndefined();
  expect(assignmentFolders(directory)).toEqual(before);
});

it('refuses a follow-up while the session is in use', async () => {
  const { directory, fake, runtime } = setup();
  const source = sourceAssignment(directory);

  await writeAssignment(source);

  const live = {
    address: 't-live',
    state: 'live',
    parent: manager,
    labels: { 'tau.assignment': assignmentPath(source.assignmentId) },
  };

  fake.reply('ls', JSON.stringify({ terminals: [live] }));
  fake.reply('get', JSON.stringify(live));

  const before = assignmentFolders(directory);
  const result = await followUp(runtime, source.assignmentId);

  expect(result.isError).toBe(true);
  expect(terminalRun(fake)).toBeUndefined();
  expect(assignmentFolders(directory)).toEqual(before);
});

it('refuses a follow-up when the session use is unknown', async () => {
  const { directory, fake, runtime } = setup();
  const source = sourceAssignment(directory);

  await writeAssignment(source);

  const live = {
    address: 't-live',
    state: 'live',
    parent: manager,
    labels: { 'tau.assignment': join(directory, 'nowhere', 'assignment.json') },
  };

  fake.reply('ls', JSON.stringify({ terminals: [live] }));
  fake.reply('get', JSON.stringify(live));

  const before = assignmentFolders(directory);
  const result = await followUp(runtime, source.assignmentId);

  expect(result.isError).toBe(true);
  expect(terminalRun(fake)).toBeUndefined();
  expect(assignmentFolders(directory)).toEqual(before);
});

it('starts a new child that resumes the source session', async () => {
  const { directory, fake, runtime } = setup();
  const extensionPath = join(directory, 'extension.js');

  writeFileSync(extensionPath, 'export default () => undefined;\n');

  const source = sourceAssignment(directory, {
    extensionPackages: [{ source: 'pkg', path: extensionPath }],
  });

  await writeAssignment(source);

  fake.replyConnect('hello', 1, {
    generation: 1,
    version: 'test',
    core: { id: 'core', name: 'core' },
    framed: false,
    methods: [],
    features: [],
  });

  fake.replyConnect('terminal.run', 2, { address: 't-new', state: 'live', parent: manager });

  const result = await followUp(runtime, source.assignmentId, { timeoutSeconds: 30 });

  expect(result.isError).not.toBe(true);

  const request = terminalRun(fake);

  expect(request).toBeDefined();

  const path = request?.labels['tau.assignment'];

  if (path === undefined) {
    throw new Error('The follow-up returned no assignment label.');
  }

  const assignment = await readAssignment(path);

  if (assignment === undefined) {
    throw new Error('The follow-up wrote no assignment file.');
  }

  expect(assignment.assignmentId).not.toBe(source.assignmentId);
  expect(assignment.session.file).toBe(source.session.file);
  expect(assignment.previousAssignmentId).toBe(source.assignmentId);
  expect(assignment.extensionPackages).toEqual([{ source: 'pkg', path: extensionPath }]);
  expect(assignment.deadline).toBe(31_000);
});

it('refuses a follow-up when the capacity is full', async () => {
  const { directory, fake, runtime } = setup();
  const source = sourceAssignment(directory);
  const other = sourceAssignment(directory);

  await writeAssignment(source);
  await writeAssignment(other);

  runtime.capacity = 1;
  runtime.refuseCapacity = vi.fn<() => void>();

  const busy = {
    address: 't-busy',
    state: 'live',
    parent: manager,
    labels: { 'tau.assignment': assignmentPath(other.assignmentId) },
  };

  fake.reply('ls', JSON.stringify({ terminals: [busy] }));
  fake.reply('get', JSON.stringify(busy));

  const before = assignmentFolders(directory);
  const result = await followUp(runtime, source.assignmentId);

  expect(result).toMatchObject({ isError: true, terminate: true });
  expect(terminalRun(fake)).toBeUndefined();
  expect(assignmentFolders(directory)).toEqual(before);
  expect(runtime.refuseCapacity).toHaveBeenCalledOnce();
});
