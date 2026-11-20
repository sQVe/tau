import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { holdFileLock } from '../../fileLock/fileLock.js';
import { HcError } from '../../hc/hc.js';
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
import type { StartingWorker } from './workerFolderDecision.js';
import { sweepWorkerFolders } from './workerFolderSweep.js';

vi.mock(import('node:fs/promises'), { spy: true });

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
      return request.params as { labels: Record<string, string>; env: Record<string, string> };
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

  fake.reply(
    'get',
    JSON.stringify({
      address: manager,
      state: 'live',
      labels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2' },
    }),
  );

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
    name: 'session path that is a folder',
    prepare: async (directory) => {
      const source = sourceAssignment(directory);

      await writeAssignment(source);
      rmSync(source.session.file);
      mkdirSync(source.session.file);

      return source.assignmentId;
    },
  },
  {
    name: 'empty session file',
    prepare: async (directory) => {
      const source = sourceAssignment(directory);

      await writeAssignment(source);
      writeFileSync(source.session.file, '');

      return source.assignmentId;
    },
  },
  {
    name: 'session file without a session header',
    prepare: async (directory) => {
      const source = sourceAssignment(directory);

      await writeAssignment(source);
      writeFileSync(source.session.file, '{"type":"message"}\n');

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

it('refuses a follow-up when the skill tool map cannot be read', async () => {
  const { directory, fake, runtime } = setup();
  const source = sourceAssignment(directory);

  await writeAssignment(source);

  runtime.readSkillTools = () => undefined;

  const before = assignmentFolders(directory);
  const result = await followUp(runtime, source.assignmentId);

  expect(result.isError).toBe(true);
  expect(terminalRun(fake)).toBeUndefined();
  expect(assignmentFolders(directory)).toEqual(before);
});

it('refuses an architect follow-up of an editing worker', async () => {
  const { directory, fake, runtime } = setup();
  const source = sourceAssignment(directory);

  await writeAssignment(source);

  vi.stubEnv('TAU_ROLE', 'architect');

  runtime.readSkillTools = () => ({ slice: ['architect'] });

  runtime.pi = {
    getCommands: () => [],
    getAllTools: () => [{ name: 'read' }],
  } as unknown as ExtensionAPI;

  const before = assignmentFolders(directory);
  const result = await followUp(runtime, source.assignmentId, { acceptance: [] });

  expect(result.isError).toBe(true);

  expect(result.content[0]?.text).toContain(
    'An architect session launches only investigation workers',
  );

  expect(terminalRun(fake)).toBeUndefined();
  expect(assignmentFolders(directory)).toEqual(before);
});

it('resumes a worker from an architect session when the skill table lists the architect tool', async () => {
  const { directory, fake, runtime } = setup();
  const source = sourceAssignment(directory);

  await writeAssignment({ ...source, loadout: { ...source.loadout, role: 'investigation' } });

  vi.stubEnv('TAU_ROLE', 'architect');

  runtime.readSkillTools = () => ({ slice: ['architect'] });

  runtime.pi = {
    getCommands: () => [],
    getAllTools: () => [{ name: 'read' }],
  } as unknown as ExtensionAPI;

  fake.replyConnect('hello', 1, {
    generation: 1,
    version: 'test',
    core: { id: 'core', name: 'core' },
    framed: false,
    methods: [],
    features: [],
  });

  fake.replyConnect('terminal.run', 2, { address: 't-new', state: 'live', parent: manager });

  const result = await followUp(runtime, source.assignmentId);

  expect(result.isError).not.toBe(true);
  expect(terminalRun(fake)).toBeDefined();
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

it('refuses a follow-up while an unresolved launch holds the session', async () => {
  const { directory, fake, runtime } = setup();
  const source = sourceAssignment(directory);

  await writeAssignment(source);

  runtime.admission.add(randomUUID(), source.session.file);

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

it('places a follow-up of an investigation worker in the workers tab of the manager', async () => {
  const { directory, fake, runtime } = setup();

  const source = sourceAssignment(directory, {
    loadout: { ...fixtureLoadout(directory), role: 'investigation' },
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

  const result = await followUp(runtime, source.assignmentId);

  expect(result.isError).not.toBe(true);
  expect(terminalRun(fake)?.labels['herdr.space']).toBe('space-1');
  expect(terminalRun(fake)?.labels['herdr.tab']).toBe('tab-2-workers');
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
  expect(result.details?.model).toBe(source.loadout.model);
  expect(result.details?.modelReason).toContain('source');

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

  expect(request?.env.TMPDIR).toBe(
    join(directory, 'tmp', 'tau-worker-scratch', assignment.assignmentId),
  );

  expect(request?.env.TAU_ASSIGNMENT_DIRECTORY).toBe(assignmentDirectory(assignment.assignmentId));
});

it('refuses a cancelled follow-up before it writes or starts anything', async () => {
  const { directory, fake, runtime } = setup();
  const source = sourceAssignment(directory);

  await writeAssignment(source);

  const controller = new AbortController();

  controller.abort();

  const before = assignmentFolders(directory);

  const result = await executeFollowUp(
    runtime,
    {
      parameters: {
        sourceAssignmentId: source.assignmentId,
        task: 'Continue the work.',
        acceptance: ['The follow-up is done.'],
      },
      startedAt: { wall: 1000, monotonic: 2 },
      parentSession: '/work/parent.jsonl',
    },
    controller.signal,
    context,
  );

  expect(result.isError).toBe(true);
  expect(terminalRun(fake)).toBeUndefined();
  expect(assignmentFolders(directory)).toEqual(before);
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

it('starts a fresh unused window after a follow-up that no sweep saw running', async () => {
  const { directory, fake, runtime } = setup();
  const hour = 3_600_000;
  const base = Date.now();
  const snapshot = join(directory, 'tmp', 'tau-worker-packages', 'snapshot-source');
  const marker = join(snapshot, '.tau-unused-since');
  const extensionPath = join(snapshot, 'node_modules', 'review-package', 'extension.js');

  mkdirSync(join(snapshot, 'node_modules', 'review-package'), { recursive: true });
  writeFileSync(extensionPath, '');
  writeFileSync(marker, '');
  utimesSync(marker, base / 1000, base / 1000);

  const source = sourceAssignment(directory, {
    packageSnapshot: snapshot,
    extensionPackages: [{ source: 'npm:review-package', path: extensionPath }],
  });

  await writeAssignment(source);

  const heldSweep = Promise.withResolvers<unknown>();
  let heldStarting: StartingWorker | undefined;

  runtime.sweepFolders = (starting) => {
    heldStarting = starting;

    return heldSweep.promise;
  };

  let clock = base + 22 * hour;

  vi.spyOn(Date, 'now').mockImplementation(() => clock);

  fake.replyConnect('hello', 1, {
    generation: 1,
    version: 'test',
    core: { id: 'core', name: 'core' },
    framed: false,
    methods: [],
    features: [],
  });

  fake.replyConnect('terminal.run', 2, { address: 't-follow-up', state: 'live', parent: manager });

  const result = await followUp(runtime, source.assignmentId);

  expect(result.isError).not.toBe(true);
  expect(heldStarting?.terminalAddress).toBe('t-follow-up');

  if (heldStarting === undefined) {
    throw new Error('The follow-up started no sweep.');
  }

  // The follow-up ends at hour 23, and no sweep ever saw it running.
  clock = base + 23 * hour;
  fake.reply('ls', JSON.stringify({ terminals: [{ address: 't-follow-up', state: 'finished' }] }));

  await sweepWorkerFolders(runtime.hc, directory, () => clock, []);

  clock = base + 24 * hour;
  await sweepWorkerFolders(runtime.hc, directory, () => clock, []);

  // The hour-0 marker must not remove the snapshot one hour after the follow-up ended.
  expect(existsSync(snapshot)).toBe(true);
  expect(statSync(marker).mtimeMs).toBeCloseTo(base + 23 * hour, -1);

  // The delayed launch sweep must not rewrite the marker its finish evidence superseded.
  await sweepWorkerFolders(runtime.hc, directory, () => clock, [heldStarting]);
  heldSweep.resolve(undefined);

  expect(statSync(marker).mtimeMs).toBeCloseTo(base + 23 * hour, -1);

  clock = base + 47 * hour - 1000;
  await sweepWorkerFolders(runtime.hc, directory, () => clock, []);
  expect(existsSync(snapshot)).toBe(true);

  clock = base + 47 * hour;
  await sweepWorkerFolders(runtime.hc, directory, () => clock, []);
  expect(existsSync(snapshot)).toBe(false);
});

it('resumes an existing local-only assignment without a snapshot directory', async () => {
  const { directory, fake, runtime } = setup();
  const extensionPath = join(directory, 'local-extension.js');
  const bogusSnapshot = join(directory, 'tmp', 'tau-worker-packages', 'snapshot-source');

  writeFileSync(extensionPath, '');

  const source = sourceAssignment(directory, {
    packageSnapshot: bogusSnapshot,
    extensionPackages: [{ source: extensionPath, path: extensionPath }],
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

  fake.replyConnect('terminal.run', 2, { address: 't-follow-up', state: 'live', parent: manager });

  const result = await followUp(runtime, source.assignmentId);

  expect(result.isError).not.toBe(true);
  expect(existsSync(bogusSnapshot)).toBe(false);

  const path = terminalRun(fake)?.labels['tau.assignment'];

  if (path === undefined) {
    throw new Error('The follow-up returned no assignment label.');
  }

  const started = await readAssignment(path);

  expect(started?.packageSnapshot).toBeNull();

  expect((await readAssignment(assignmentPath(source.assignmentId)))?.packageSnapshot).toBe(
    bogusSnapshot,
  );
});

const packageBackedSource = async (
  directory: string,
): Promise<{ source: Assignment; snapshot: string; extensionPath: string }> => {
  const snapshot = join(directory, 'tmp', 'tau-worker-packages', 'snapshot-source');
  const extensionPath = join(snapshot, 'node_modules', 'review-package', 'extension.js');

  mkdirSync(join(snapshot, 'node_modules', 'review-package'), { recursive: true });
  writeFileSync(extensionPath, '');

  const source = sourceAssignment(directory, {
    packageSnapshot: snapshot,
    extensionPackages: [{ source: 'npm:review-package', path: extensionPath }],
  });

  await writeAssignment(source);

  return { source, snapshot, extensionPath };
};

const lockPathFor = (directory: string): string => join(directory, '.tau-worker-folder-sweep.lock');

const listCalls = (fake: HcFake): number =>
  fake.calls.filter((call) => call.commandArguments[0] === 'ls').length;

const followUpWithSignal = (
  runtime: LaunchRuntime,
  sourceAssignmentId: string,
  signal: AbortSignal,
) =>
  executeFollowUp(
    runtime,
    {
      parameters: {
        sourceAssignmentId,
        task: 'Continue the work.',
        acceptance: ['The follow-up is done.'],
      },
      startedAt: { wall: 1000, monotonic: 2 },
      parentSession: '/work/parent.jsonl',
    },
    signal,
    context,
  );

it('cancels a package-backed follow-up that waits for the sweep lock', async () => {
  const { directory, fake, runtime } = setup();
  const { source } = await packageBackedSource(directory);

  const held = await holdFileLock({
    lockPath: lockPathFor(directory),
    checkout: directory,
    terminal: undefined,
  });

  if (held.kind !== 'held') {
    throw new Error('Another session already holds the sweep lock.');
  }

  onTestFinished(() => held.release());

  const controller = new AbortController();
  const result = followUpWithSignal(runtime, source.assignmentId, controller.signal);

  await vi.waitFor(() => {
    expect(listCalls(fake)).toBe(2);
  });

  controller.abort();

  await expect(result).resolves.toMatchObject({ isError: true });
  expect(terminalRun(fake)).toBeUndefined();
});

it('starts no terminal when a waited follow-up lost its package paths', async () => {
  const { directory, fake, runtime } = setup();
  const { source, snapshot } = await packageBackedSource(directory);

  const held = await holdFileLock({
    lockPath: lockPathFor(directory),
    checkout: directory,
    terminal: undefined,
  });

  if (held.kind !== 'held') {
    throw new Error('Another session already holds the sweep lock.');
  }

  onTestFinished(() => held.release());

  const result = followUp(runtime, source.assignmentId);

  await vi.waitFor(() => {
    expect(listCalls(fake)).toBe(2);
  });

  rmSync(snapshot, { recursive: true, force: true });
  await held.release();

  await expect(result).resolves.toMatchObject({ isError: true });
  expect(terminalRun(fake)).toBeUndefined();
});

it('starts no terminal and releases the lock when the old marker clear fails', async () => {
  const { directory, fake, runtime } = setup();
  const { source, snapshot } = await packageBackedSource(directory);
  const marker = join(snapshot, '.tau-unused-since');
  const priorMarker = Date.now() - 3_600_000;

  mkdirSync(marker);
  utimesSync(marker, priorMarker / 1000, priorMarker / 1000);

  const result = await followUp(runtime, source.assignmentId);

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('Clearing the unused marker');
  expect(terminalRun(fake)).toBeUndefined();
  expect(existsSync(marker)).toBe(true);
  expect(statSync(marker).mtimeMs).toBeCloseTo(priorMarker, -1);

  const held = await holdFileLock({
    lockPath: lockPathFor(directory),
    checkout: directory,
    terminal: undefined,
  });

  expect(held.kind).toBe('held');

  if (held.kind === 'held') {
    await held.release();
  }
});

it('restores the prior marker when a package-backed follow-up fails to start', async () => {
  const { directory, fake, runtime } = setup();
  const { source, snapshot } = await packageBackedSource(directory);
  const marker = join(snapshot, '.tau-unused-since');
  const priorMarker = Date.now() - 3_600_000;

  writeFileSync(marker, '');
  utimesSync(marker, priorMarker / 1000, priorMarker / 1000);

  runtime.hc.connect = () => Promise.reject(new HcError('spawn_failed', 'launch failure'));

  const result = await followUp(runtime, source.assignmentId);

  expect(result.isError).toBe(true);
  expect(terminalRun(fake)).toBeUndefined();
  expect(statSync(marker).mtimeMs).toBeCloseTo(priorMarker, -1);
});

it('keeps the marker cleared when a package-backed follow-up start is unclear', async () => {
  const { directory, runtime } = setup();
  const { source, snapshot } = await packageBackedSource(directory);
  const marker = join(snapshot, '.tau-unused-since');

  writeFileSync(marker, '');
  utimesSync(marker, (Date.now() - 3_600_000) / 1000, (Date.now() - 3_600_000) / 1000);

  runtime.hc.connect = () => Promise.reject(new HcError('connect_failed', 'launch failure'));

  const result = await followUp(runtime, source.assignmentId);

  expect(result.isError).toBe(true);
  expect(existsSync(marker)).toBe(false);
});

it('keeps the started follow-up and warns when the sweep lock release fails', async () => {
  const { directory, fake, runtime } = setup();
  const { source } = await packageBackedSource(directory);
  const generation = `${lockPathFor(directory)}.1`;
  const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
  const rename = vi.mocked(fsPromises.rename);
  const truncate = vi.mocked(fsPromises.truncate);
  const originalRename = rename.getMockImplementation() ?? actual.rename;
  const originalTruncate = truncate.getMockImplementation() ?? actual.truncate;

  rename.mockImplementation(((from: string, to: string) =>
    to === generation
      ? Promise.reject(new Error('rename failed'))
      : originalRename(from, to)) as typeof fsPromises.rename);

  truncate.mockImplementation(((path: string, length?: number) =>
    path === generation
      ? Promise.reject(new Error('truncate failed'))
      : originalTruncate(path, length)) as typeof fsPromises.truncate);

  onTestFinished(() => {
    rename.mockImplementation(originalRename);
    truncate.mockImplementation(originalTruncate);
  });

  const sweepFolders = vi.fn<NonNullable<LaunchRuntime['sweepFolders']>>(() => Promise.resolve());

  runtime.sweepFolders = sweepFolders;

  fake.replyConnect('hello', 1, {
    generation: 1,
    version: 'test',
    core: { id: 'core', name: 'core' },
    framed: false,
    methods: [],
    features: [],
  });

  fake.replyConnect('terminal.run', 2, { address: 't-follow-up', state: 'live', parent: manager });

  const result = await followUp(runtime, source.assignmentId);

  expect(result.isError).not.toBe(true);
  expect(result.details?.address).toBe('t-follow-up');
  expect(result.details?.warning).toContain('not released');
  expect(terminalRun(fake)).toBeDefined();
  expect(sweepFolders).not.toHaveBeenCalled();
});

it('submits the background sweep after releasing the copied snapshot lock', async () => {
  const { directory, fake, runtime } = setup();
  const { source } = await packageBackedSource(directory);
  const generation = `${lockPathFor(directory)}.1`;
  const releasedAtSubmission: boolean[] = [];

  const sweepFolders = vi.fn<NonNullable<LaunchRuntime['sweepFolders']>>(() => {
    const owner = existsSync(generation)
      ? (JSON.parse(readFileSync(generation, 'utf8')) as { released?: boolean })
      : undefined;

    releasedAtSubmission.push(owner?.released === true);

    return Promise.resolve();
  });

  runtime.sweepFolders = sweepFolders;

  fake.replyConnect('hello', 1, {
    generation: 1,
    version: 'test',
    core: { id: 'core', name: 'core' },
    framed: false,
    methods: [],
    features: [],
  });

  fake.replyConnect('terminal.run', 2, { address: 't-follow-up', state: 'live', parent: manager });

  const result = await followUp(runtime, source.assignmentId);

  expect(result.isError).not.toBe(true);
  expect(sweepFolders).toHaveBeenCalledTimes(1);
  expect(releasedAtSubmission).toEqual([true]);
});
