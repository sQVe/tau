import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { Exec } from '../../command.js';
import type { Connect } from '../../hc/connect.js';
import { HcError } from '../../hc/hc.js';
import type { HcTerminal } from '../../hc/hc.js';
import { assignmentDirectory, writeAssignment } from './assignment.js';
import { savedAssignment } from './fixtures/deliveryManager.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { writeFakePackage } from './fixtures/packageCache.js';
import { Admission, executeLaunch, startReservedWorker } from './launch.js';
import type { LaunchRuntime } from './launch.js';
import type { LaunchParameters } from './launchParameters.js';
import * as loadouts from './loadout.js';
import * as packageSnapshot from './packageSnapshot.js';
import { scratchRootFor } from './workerScratch.js';

vi.mock(import('./assignment.js'), { spy: true });
vi.mock(import('./loadout.js'), { spy: true });
vi.mock(import('./packageSnapshot.js'), { spy: true });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const loadout = fixtureLoadout('/work');

const manager = 'manager';

const assignmentId = '11111111-1111-1111-1111-111111111111';

const existingChild = {
  address: 't-existing',
  state: 'live',
  parent: manager,
  labels: { 'tau.assignment': `/agent/tau/x/assignments/${assignmentId}/assignment.json` },
};

const terminalRun = (fake: HcFake) => {
  for (const call of fake.connectCalls) {
    const request = call.find((message) => message.method === 'terminal.run');

    if (request !== undefined) {
      return request.params as {
        name: string;
        labels: Record<string, string>;
        env: Record<string, string>;
      };
    }
  }

  return undefined;
};

const succeeded = (value: unknown) => ({
  code: 0,
  killed: false,
  truncated: false,
  stdout: JSON.stringify(value),
  stderr: '',
});

const setup = (
  options: { children?: HcTerminal[]; managerLabels?: Record<string, string> } = {},
): {
  fake: HcFake;
  runtime: LaunchRuntime;
  refuseCapacity: ReturnType<typeof vi.fn>;
  scratchExistedAtRun: () => boolean | undefined;
} => {
  const directory = temporaryDirectory(onTestFinished, 'tau-launch-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', manager);

  vi.mocked(loadouts.resolveLoadout).mockReturnValue(loadout);

  const fake = createHcFake();

  const managerTerminal: HcTerminal = {
    address: manager,
    state: 'live',
    labels: options.managerLabels ?? {},
  };

  const children = options.children ?? [];
  const launched: HcTerminal[] = [];
  let scratchExistedAtRun: boolean | undefined;

  fake.replyConnect('hello', 1, {
    generation: 1,
    version: 'test',
    core: {
      id: 'core',
      name: 'core',
    },
    framed: false,
    methods: [],
    features: [],
  });

  fake.replyConnect('terminal.run', 2, { address: 't-worker', state: 'live', parent: manager });

  const exec: Exec = (command, commandArguments, execOptions) => {
    if (command === 'hc' && commandArguments[0] === 'ls') {
      return Promise.resolve(succeeded({ terminals: [...children, ...launched] }));
    }

    if (command === 'hc' && commandArguments[0] === 'get') {
      const address = commandArguments.at(-1);

      const terminal =
        address === manager
          ? managerTerminal
          : [...children, ...launched].find((child) => child.address === address);

      const terminalResult =
        terminal === undefined
          ? { code: 1, killed: false, truncated: false, stdout: '', stderr: 'not_found' }
          : succeeded(terminal);

      return Promise.resolve(terminalResult);
    }

    return fake.exec(command, commandArguments, execOptions);
  };

  const connect: Connect = (lines, connectOptions) => {
    const request = lines
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            params?: { labels?: Record<string, string>; env?: Record<string, string> };
          },
      )
      .find((message) => message.method === 'terminal.run');

    if (request !== undefined) {
      scratchExistedAtRun = existsSync(request.params?.env?.TMPDIR ?? '');

      launched.push({
        address: 't-worker',
        state: 'live',
        parent: manager,
        labels: request.params?.labels ?? {},
      });
    }

    return fake.connect(lines, connectOptions);
  };

  const refuseCapacity = vi.fn<() => void>();

  const runtime: LaunchRuntime = {
    pi: { getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI,
    hc: { exec, connect, cwd: directory },
    capacity: 2,
    admission: new Admission(),
    readSkillTools: () => ({}),
    agentDirectory: directory,
    processEnvironment: { PATH: process.env.PATH },
    refuseCapacity,
  };

  return { fake, runtime, refuseCapacity, scratchExistedAtRun: () => scratchExistedAtRun };
};

const context = {
  sessionManager: { getSessionId: () => 'parent-one' },
} as unknown as ExtensionContext;

const launch = (
  runtime: LaunchRuntime,
  parameters: Partial<LaunchParameters> = {},
  signal?: AbortSignal,
) =>
  executeLaunch(
    runtime,
    {
      parameters: {
        task: 'Fix the counts.',
        profile: 'worker',
        acceptance: ['Done.'],
        ...parameters,
      },
      startedAt: { wall: 1000, monotonic: 2 },
      parentSession: '/work/parent.jsonl',
    },
    signal,
    context,
  );

const uncertainSetup = (
  kind:
    | 'missing_reply'
    | 'read_failed'
    | 'malformed'
    | 'unexpected'
    | 'aborted'
    | 'spawn_failed'
    | 'connect_failed',
  packages: string[] = [],
) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-launch-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const uncertainLoadout = { ...fixtureLoadout(directory), packages };
  const fake = createHcFake();
  let launches = 0;

  fake.reply('ls', JSON.stringify({ terminals: [] }));
  fake.reply('get', JSON.stringify({ address: manager, state: 'live', labels: {} }));

  vi.mocked(loadouts.resolveLoadout).mockReturnValue(uncertainLoadout);

  const runtime: LaunchRuntime = {
    pi: { getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI,
    hc: {
      exec: fake.exec,
      connect: () => {
        launches += 1;

        return Promise.reject(new HcError(kind, 'launch failure'));
      },
      cwd: directory,
    },
    capacity: 1,
    admission: new Admission(),
    readSkillTools: () => ({}),
    agentDirectory: directory,
    processEnvironment: { PATH: process.env.PATH },
    buildCommand: () => ['sleep', '60'],
    packageManager: (() => ({
      listConfiguredPackages: () => [],
      resolveExtensionSources: async ([source = '']: string[]) => ({
        extensions: [
          {
            path: source,
            enabled: true,
            metadata: {
              source,
              scope: 'temporary',
              origin: 'package',
              packageRoot: writeFakePackage(directory, source),
            },
          },
        ],
        skills: [],
        prompts: [],
        themes: [],
      }),
    })) as unknown as NonNullable<LaunchRuntime['packageManager']>,
  };

  return { directory, fake, runtime, launches: () => launches };
};

const scratchNames = (directory: string): string[] => {
  const root = scratchRootFor(directory);

  return existsSync(root) ? readdirSync(root) : [];
};

const snapshotNames = (directory: string): string[] => {
  const root = join(directory, 'tmp', 'tau-worker-packages');

  return existsSync(root) ? readdirSync(root) : [];
};

it('starts one of two concurrent launches and refuses the other', async () => {
  vi.mocked(loadouts.resolveLoadout).mockReturnValue(loadout);

  const { fake, runtime, refuseCapacity } = setup({ children: [existingChild] });

  const [first, second] = await Promise.all([launch(runtime, {}), launch(runtime, {})]);

  expect(first.isError).not.toBe(true);
  expect(second).toMatchObject({ isError: true, terminate: true });
  expect(fake.connectCalls).toHaveLength(1);
  expect(refuseCapacity).toHaveBeenCalledOnce();
});

it('refuses a launch when the fresh skill table needs an unregistered tool', async () => {
  const { runtime } = setup();

  runtime.readSkillTools = () => ({ scout: ['review_new_unregistered_tool'] });

  runtime.pi = {
    getCommands: () => [],
    getAllTools: () => [{ name: 'read' }],
  } as unknown as ExtensionAPI;

  vi.mocked(loadouts.resolveLoadout).mockReturnValue(loadout);

  const result = await launch(runtime, {});

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('review_new_unregistered_tool');
});

it('launches from an architect session when the skill table lists the architect tool', async () => {
  const { runtime } = setup();

  vi.stubEnv('TAU_ROLE', 'architect');

  runtime.readSkillTools = () => ({ slice: ['architect'] });

  runtime.pi = {
    getCommands: () => [],
    getAllTools: () => [{ name: 'read' }],
  } as unknown as ExtensionAPI;

  vi.mocked(loadouts.resolveLoadout).mockReturnValue({
    ...loadout,
    role: 'investigation',
    profile: 'scout',
  });

  const result = await launch(runtime, {});

  expect(result.isError).not.toBe(true);
});

it('refuses an editing launch from an architect session', async () => {
  const { fake, runtime } = setup();

  vi.stubEnv('TAU_ROLE', 'architect');

  runtime.readSkillTools = () => ({ slice: ['architect'] });

  runtime.pi = {
    getCommands: () => [],
    getAllTools: () => [{ name: 'read' }],
  } as unknown as ExtensionAPI;

  vi.mocked(loadouts.resolveLoadout).mockReturnValue(loadout);

  const result = await launch(runtime, { acceptance: [] });

  expect(result.isError).toBe(true);

  expect(result.content[0]?.text).toContain(
    'An architect session launches only investigation workers',
  );

  expect(existsSync(join(runtime.agentDirectory, 'tau'))).toBe(false);
  expect(fake.connectCalls).toEqual([]);
});

it('refuses an editing launch without acceptance criteria', async () => {
  const { runtime } = setup();
  const result = await launch(runtime, { acceptance: [] });

  expect(result).toMatchObject({ isError: true });
  expect(result.content[0]?.text).toContain('acceptance criteria');
});

it('launches the worker profile without model', async () => {
  const { fake, runtime } = setup();

  const result = await launch(runtime, { profile: 'worker' });

  expect(result.isError).not.toBe(true);
  expect(terminalRun(fake)).toBeDefined();
  expect(fake.connectCalls).toHaveLength(1);
});

it('reports a failed loadout check', async () => {
  const { runtime } = setup();

  vi.mocked(loadouts.resolveLoadout).mockImplementation(() => {
    throw new Error('Worker profile package failed to load.');
  });

  const result = await launch(runtime, {});

  expect(result).toMatchObject({ isError: true });
  expect(result.content[0]?.text).toContain('package');
});

it('writes the tau labels and no space and tab labels when the manager has no tab', async () => {
  vi.mocked(loadouts.resolveLoadout).mockReturnValue(loadout);

  const { fake, runtime } = setup({ managerLabels: { 'herdr.space': 'space-1' } });

  const result = await launch(runtime, {});

  const request = terminalRun(fake);

  expect(result.isError).not.toBe(true);

  expect(request?.labels).toMatchObject({
    'tau.profile': 'worker',
    'tau.model': 'faux/test',
    'tau.deadline': '3601000',
    'tau.task': 'Fix the counts.',
  });

  expect(request?.labels['tau.assignment']).toContain('/assignments/');
  expect(request?.labels['herdr.space']).toBeUndefined();
  expect(request?.labels['herdr.tab']).toBeUndefined();
});

it('places an editing worker in the workers tab of the manager', async () => {
  vi.mocked(loadouts.resolveLoadout).mockReturnValue(loadout);

  const { fake, runtime } = setup({
    managerLabels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2' },
  });

  await launch(runtime, {});
  const request = terminalRun(fake);

  expect(request?.labels['herdr.space']).toBe('space-1');
  expect(request?.labels['herdr.tab']).toBe('tab-2-workers');
});

it.each(['missing_reply', 'read_failed', 'malformed', 'unexpected'] as const)(
  'reconciles an unclear %s launch that finds the worker',
  async (kind) => {
    const state = uncertainSetup(kind);
    const worker = { address: 'worker', name: '', state: 'live', parent: manager, labels: {} };

    state.runtime.hc.connect = async (lines) => {
      const request = JSON.parse(lines[1] ?? '') as {
        params: { name: string; labels: Record<string, string> };
      };

      worker.name = request.params.name;
      worker.labels = request.params.labels;
      state.fake.reply('ls', JSON.stringify({ terminals: [worker] }));
      state.fake.reply('get', JSON.stringify(worker));

      throw new HcError(kind, 'launch failure');
    };

    const result = await launch(state.runtime, {});

    expect(result.isError).not.toBe(true);
    expect(result.details?.address).toBe('worker');
    expect(scratchNames(state.directory)).toHaveLength(1);
  },
);

it('reconciles a connect_failed launch by name', async () => {
  const state = uncertainSetup('connect_failed');

  state.runtime.hc.connect = async (lines) => {
    const request = JSON.parse(lines[1] ?? '') as {
      params: { name: string; labels: Record<string, string> };
    };

    const worker = {
      address: 'worker',
      name: request.params.name,
      state: 'live',
      parent: manager,
      labels: request.params.labels,
    };

    state.fake.reply('ls', JSON.stringify({ terminals: [worker] }));
    state.fake.reply('get', JSON.stringify(worker));

    throw new HcError('connect_failed', 'hc connect failed: kill EPERM');
  };

  const result = await launch(state.runtime, {});

  expect(result.isError).not.toBe(true);
  expect(result.details?.address).toBe('worker');
  expect(scratchNames(state.directory)).toHaveLength(1);
});

it('reconciles an aborted launch request that started the worker', async () => {
  const state = uncertainSetup('aborted', ['npm:review-package']);
  const controller = new AbortController();
  let seenSignal: AbortSignal | undefined;

  state.runtime.hc.connect = async (lines, options) => {
    seenSignal = options?.signal;

    const request = JSON.parse(lines[1] ?? '') as {
      params: { name: string; labels: Record<string, string> };
    };

    const worker = {
      address: 'worker',
      name: request.params.name,
      state: 'live',
      parent: manager,
      labels: request.params.labels,
    };

    state.fake.reply('ls', JSON.stringify({ terminals: [worker] }));
    state.fake.reply('get', JSON.stringify(worker));

    controller.abort();

    throw new HcError('aborted', 'launch request aborted');
  };

  const result = await launch(state.runtime, {}, controller.signal);

  expect(seenSignal).toBe(controller.signal);
  expect(result.isError).not.toBe(true);
  expect(result.details?.address).toBe('worker');
  expect(snapshotNames(state.directory)).toHaveLength(1);
  expect(scratchNames(state.directory)).toHaveLength(1);
});

it('frees the slot and removes the scratch folder when an unclear launch finds no worker', async () => {
  const state = uncertainSetup('missing_reply');

  const first = await launch(state.runtime, {});

  expect(scratchNames(state.directory)).toEqual([]);

  const second = await launch(state.runtime, {});

  expect(first.isError).toBe(true);
  expect(state.launches()).toBe(2);
  expect(second.content[0]?.text).not.toContain('capacity full');
});

const reconciliationFailureSetup = (failure: 'ls' | 'get') => {
  const state = uncertainSetup('read_failed', ['npm:review-package']);

  state.runtime.hc.connect = async (lines) => {
    const request = JSON.parse(lines[1] ?? '') as {
      params: { name: string; labels: Record<string, string> };
    };

    const worker = {
      address: 'worker',
      name: request.params.name,
      state: 'live',
      parent: manager,
      labels: request.params.labels,
    };

    state.fake.reply('ls', JSON.stringify({ terminals: [worker] }));
    state.fake.fail(failure, 'temporary lookup failure', 1);

    throw new HcError('read_failed', 'lost launch reply');
  };

  return state;
};

it.each(['ls', 'get'] as const)(
  'keeps the reservation, snapshot, and scratch folder when reconciliation %s fails',
  async (failure) => {
    const state = reconciliationFailureSetup(failure);

    const result = await launch(state.runtime, {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('unclear');
    expect(result.content[0]?.text).toContain('hc ls');
    expect(snapshotNames(state.directory)).toHaveLength(1);
    expect(scratchNames(state.directory)).toHaveLength(1);

    const empty = createHcFake();

    empty.reply('ls', JSON.stringify({ terminals: [] }));

    state.runtime.hc.exec = empty.exec;

    const second = await launch(state.runtime, {});

    expect(second.isError).toBe(true);
    expect(second.content[0]?.text).toContain('capacity full');
  },
);

it('reports a definite error and frees the slot when the manager read and the reconciliation list both fail', async () => {
  const state = uncertainSetup('read_failed', ['npm:review-package']);
  const listExec = state.runtime.hc.exec;
  let listings = 0;

  state.fake.fail('get', 'manager read failure', 1);

  state.runtime.hc.exec = (command, commandArguments, execOptions) => {
    if (command === 'hc' && commandArguments[0] === 'ls') {
      listings += 1;

      if (listings > 1) {
        state.fake.fail('ls', 'list failure', 1);
      }
    }

    return listExec(command, commandArguments, execOptions);
  };

  const first = await launch(state.runtime, {});

  expect(first.isError).toBe(true);
  expect(first.content[0]?.text).not.toContain('launch is unclear');

  const empty = createHcFake();

  empty.reply('ls', JSON.stringify({ terminals: [] }));

  state.runtime.hc.exec = empty.exec;

  const second = await launch(state.runtime, {});

  expect(second.content[0]?.text).not.toContain('capacity full');
});

it('a launch writes a null routing record', async () => {
  vi.mocked(loadouts.resolveLoadout).mockReturnValue(loadout);

  const { runtime } = setup();
  const result = await launch(runtime, {});

  expect(result.isError).not.toBe(true);

  const saved = vi.mocked(writeAssignment).mock.calls.at(-1)?.[0];

  expect(saved?.routing).toBeNull();
});

it('removes the snapshot after a definite launch failure', async () => {
  const state = uncertainSetup('spawn_failed', ['npm:review-package']);
  const result = await launch(state.runtime, {});

  expect(result.isError).toBe(true);
  expect(snapshotNames(state.directory)).toEqual([]);
});

it('creates the scratch folder before the worker starts', async () => {
  const { fake, runtime, scratchExistedAtRun } = setup();

  const result = await launch(runtime, {});
  const request = terminalRun(fake);
  const scratch = request?.env.TMPDIR ?? '';

  expect(result.isError).not.toBe(true);
  const launchedId = vi.mocked(writeAssignment).mock.calls.at(-1)?.[0].assignmentId ?? '';

  expect(launchedId).not.toBe('');
  expect(scratchExistedAtRun()).toBe(true);
  expect(scratch).toBe(join(scratchRootFor(runtime.agentDirectory), launchedId));
  expect(request?.env.TAU_ASSIGNMENT_DIRECTORY).toBe(assignmentDirectory(launchedId));
  expect([request?.env.TMP, request?.env.TEMP]).toEqual([scratch, scratch]);
  expect(scratchNames(runtime.agentDirectory)).toHaveLength(1);
});

const hourInMilliseconds = 3_600_000;

const fakeDateAfter = (path: string, milliseconds: number): void => {
  vi.useFakeTimers({ toFake: ['Date'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  vi.setSystemTime(statSync(path).birthtimeMs + milliseconds);
};

const markUnusedSinceBirth = (snapshot: string): void => {
  const marker = join(snapshot, '.tau-unused-since');
  const birth = statSync(snapshot).birthtimeMs / 1000;

  writeFileSync(marker, '');
  utimesSync(marker, birth, birth);
};

it('returns before the sweep settles', async () => {
  const { runtime } = setup();

  const neverSettles = Promise.withResolvers<never>().promise;
  const sweepFolders = vi.fn<NonNullable<LaunchRuntime['sweepFolders']>>(() => neverSettles);

  runtime.sweepFolders = sweepFolders;

  const result = await launch(runtime, {});
  const launchedId = vi.mocked(writeAssignment).mock.calls.at(-1)?.[0].assignmentId;

  expect(result.isError).not.toBe(true);
  expect(sweepFolders).toHaveBeenCalledTimes(1);

  expect(sweepFolders.mock.calls[0]?.[0]).toEqual({
    kind: 'read',
    assignmentId: launchedId,
    running: true,
    packageSnapshot: null,
    terminalAddress: 't-worker',
  });
});

it('records no package snapshot for a local-only package list', async () => {
  const { fake, runtime } = setup();
  const localPackage = join(runtime.agentDirectory, 'local-package.js');

  writeFileSync(localPackage, '');

  vi.mocked(loadouts.resolveLoadout).mockReturnValue({
    ...fixtureLoadout(runtime.agentDirectory),
    packages: [localPackage],
  });

  const result = await launch(runtime, {});

  expect(result.isError).not.toBe(true);
  expect(terminalRun(fake)).toBeDefined();

  const assignment = vi.mocked(writeAssignment).mock.calls.at(-1)?.[0];

  expect(assignment?.packageSnapshot).toBeNull();
});

it('passes the starting fact with the basename of the snapshot to the sweep', async () => {
  const { runtime } = setup();
  const sweepFolders = vi.fn<NonNullable<LaunchRuntime['sweepFolders']>>(() => Promise.resolve());
  const snapshot = join(runtime.agentDirectory, 'tmp', 'tau-worker-packages', 'source-launch');

  const assignment = {
    ...savedAssignment(runtime.agentDirectory, null),
    packageSnapshot: snapshot,
  };

  runtime.sweepFolders = sweepFolders;

  await writeAssignment(assignment);

  await startReservedWorker(runtime, {
    assignment,
    task: 'Follow up.',
    label: undefined,
    extensionPackages: [],
    skillTools: {},
    modelReason: 'Reused.',
    signal: undefined,
  });

  expect(sweepFolders.mock.calls[0]?.[0]).toEqual({
    kind: 'read',
    assignmentId: assignment.assignmentId,
    running: true,
    packageSnapshot: 'source-launch',
    terminalAddress: 't-worker',
  });
});

it('keeps the launch folders and its snapshot when hc lists no worker', async () => {
  const { runtime } = setup();
  const snapshotRoot = join(runtime.agentDirectory, 'tmp', 'tau-worker-packages');
  const reused = join(snapshotRoot, 'source-launch');
  const unused = join(snapshotRoot, 'unused-launch');
  const realExec = runtime.hc.exec;

  runtime.hc.exec = (command, commandArguments, options) =>
    commandArguments[0] === 'ls'
      ? Promise.resolve(succeeded({ terminals: [] }))
      : realExec(command, commandArguments, options);

  mkdirSync(reused, { recursive: true });
  mkdirSync(unused, { recursive: true });
  markUnusedSinceBirth(unused);
  markUnusedSinceBirth(reused);
  fakeDateAfter(reused, 25 * hourInMilliseconds);

  const assignment = { ...savedAssignment(runtime.agentDirectory, null), packageSnapshot: reused };

  await startReservedWorker(runtime, {
    assignment,
    task: 'Follow up.',
    label: undefined,
    extensionPackages: [],
    skillTools: {},
    modelReason: 'Reused.',
    signal: undefined,
  });

  await vi.waitFor(() => {
    expect(existsSync(unused)).toBe(false);
  });

  expect(existsSync(reused)).toBe(true);
  expect(scratchNames(runtime.agentDirectory)).toEqual([assignment.assignmentId]);
});

it('launches when the sweep rejects', async () => {
  const { runtime } = setup();

  runtime.sweepFolders = () => Promise.reject(new Error('sweep failed'));

  const result = await launch(runtime, {});

  expect(result.isError).not.toBe(true);
});

it('starts no sweep after a definite launch failure', async () => {
  const state = uncertainSetup('spawn_failed');
  const sweepFolders = vi.fn<NonNullable<LaunchRuntime['sweepFolders']>>(() => Promise.resolve());

  state.runtime.sweepFolders = sweepFolders;

  const result = await launch(state.runtime, {});

  expect(result.isError).toBe(true);
  expect(sweepFolders).not.toHaveBeenCalled();
});

it('starts the sweep after the worker started', async () => {
  const { fake, runtime } = setup();
  let workerStartedAtSweep: boolean | undefined;

  runtime.sweepFolders = () => {
    workerStartedAtSweep = terminalRun(fake) !== undefined;

    return Promise.resolve();
  };

  await launch(runtime, {});

  expect(workerStartedAtSweep).toBe(true);
});

it('removes the scratch folder of an ended worker after the launch', async () => {
  const { runtime } = setup();
  const stale = join(scratchRootFor(runtime.agentDirectory), 'ended-assignment');

  mkdirSync(stale, { recursive: true });
  fakeDateAfter(stale, 2 * 60_000);

  const result = await launch(runtime, {});

  expect(result.isError).not.toBe(true);

  await vi.waitFor(() => {
    expect(existsSync(stale)).toBe(false);
  });

  expect(scratchNames(runtime.agentDirectory)).toHaveLength(1);
});

it('keeps the old snapshot a starting follow-up reuses', async () => {
  const { runtime } = setup();
  const snapshotRoot = join(runtime.agentDirectory, 'tmp', 'tau-worker-packages');
  const reused = join(snapshotRoot, 'source-launch');
  const unused = join(snapshotRoot, 'unused-launch');

  mkdirSync(reused, { recursive: true });
  mkdirSync(unused, { recursive: true });
  markUnusedSinceBirth(unused);
  markUnusedSinceBirth(reused);
  fakeDateAfter(reused, 25 * hourInMilliseconds);

  const assignment = { ...savedAssignment(runtime.agentDirectory, null), packageSnapshot: reused };

  await writeAssignment(assignment);

  const result = await startReservedWorker(runtime, {
    assignment,
    task: 'Follow up.',
    label: undefined,
    extensionPackages: [],
    skillTools: {},
    modelReason: 'Reused.',
    signal: undefined,
  });

  expect(result.isError).not.toBe(true);

  await vi.waitFor(() => {
    expect(existsSync(unused)).toBe(false);
  });

  expect(existsSync(reused)).toBe(true);
});

it('removes the scratch folder after a definite launch failure', async () => {
  const state = uncertainSetup('spawn_failed');
  const result = await launch(state.runtime, {});

  expect(result.isError).toBe(true);
  expect(scratchNames(state.directory)).toEqual([]);
});

it('keeps the scratch cleanup error in the launch error', async () => {
  const state = uncertainSetup('spawn_failed');
  const elsewhere = temporaryDirectory(onTestFinished, 'tau-launch-redirect-');

  state.runtime.hc.connect = async () => {
    const root = scratchRootFor(state.directory);

    renameSync(root, join(elsewhere, 'moved'));
    symlinkSync(join(elsewhere, 'moved'), root);

    throw new HcError('spawn_failed', 'launch failure');
  };

  const result = await launch(state.runtime, {});

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('launch failure');
  expect(result.content[0]?.text).toContain('Also failed to remove the worker scratch folder');
  expect(readdirSync(join(elsewhere, 'moved'))).toHaveLength(1);
});

it('saves installed extension packages', async () => {
  const state = uncertainSetup('spawn_failed', ['npm:review-package']);

  await launch(state.runtime, {});

  const saved = vi.mocked(writeAssignment).mock.calls.at(-1)?.[0];
  const installed = saved?.extensionPackages;

  expect(installed?.[0]?.source).toBe('npm:review-package');
  expect(installed?.[0]?.path).toContain('tau-worker-packages');
});

it('keeps the cleanup error in the launch error when snapshot removal also fails', async () => {
  const cleanupError = 'Package snapshot root is redirected. Cleanup refused.';

  vi.mocked(packageSnapshot.removeSnapshotDirectory).mockResolvedValueOnce(cleanupError);
  const state = uncertainSetup('spawn_failed', ['npm:review-package']);
  const result = await launch(state.runtime, {});

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('launch failure');
  expect(result.content[0]?.text).toContain(cleanupError);
});

it('removes the snapshot after a failed assignment write', async () => {
  const state = uncertainSetup('read_failed', ['npm:review-package']);

  mkdirSync(state.directory, { recursive: true });
  writeFileSync(join(state.directory, 'tau'), 'blocked');

  const result = await launch(state.runtime, {});

  expect(result.isError).toBe(true);
  expect(snapshotNames(state.directory)).toEqual([]);
});

it('refuses a launch aborted while it waits for admission', async () => {
  vi.mocked(loadouts.resolveLoadout).mockReturnValue(loadout);

  const { fake, runtime } = setup();
  const controller = new AbortController();
  const release = Promise.withResolvers<undefined>();
  const held = runtime.admission.run(() => release.promise);
  const pending = launch(runtime, {}, controller.signal);

  controller.abort();
  release.resolve(undefined);
  await held;

  const result = await pending;

  expect(result.isError).toBe(true);
  expect(terminalRun(fake)).toBeUndefined();
  expect(fake.connectCalls).toHaveLength(0);
});

it('frees the slot and removes the snapshot when the signal aborts after admission', async () => {
  const { fake, runtime } = setup();

  const packagedLoadout = {
    ...fixtureLoadout(runtime.agentDirectory),
    packages: ['npm:review-package'],
  };

  vi.mocked(loadouts.resolveLoadout).mockReturnValue(packagedLoadout);

  const controller = new AbortController();

  runtime.capacity = 1;

  runtime.packageManager = (() => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: async ([source = '']: string[]) => ({
      extensions: [
        {
          path: source,
          enabled: true,
          metadata: {
            source,
            scope: 'temporary',
            origin: 'package',
            packageRoot: writeFakePackage(runtime.agentDirectory, source),
          },
        },
      ],
      skills: [],
      prompts: [],
      themes: [],
    }),
  })) as unknown as NonNullable<LaunchRuntime['packageManager']>;

  vi.mocked(writeAssignment).mockImplementation(async () => {
    queueMicrotask(() => {
      controller.abort();
    });
  });

  const result = await launch(runtime, {}, controller.signal);

  expect(result.isError).toBe(true);
  expect(terminalRun(fake)).toBeUndefined();
  expect(fake.connectCalls).toHaveLength(0);

  expect(snapshotNames(runtime.agentDirectory)).toEqual([]);

  vi.mocked(writeAssignment).mockRestore();

  const second = await launch(runtime, {});

  expect(second.isError).not.toBe(true);
  expect(terminalRun(fake)).toBeDefined();
});

it('frees a confirmed slot when hc removed the child before the next launch', async () => {
  vi.mocked(loadouts.resolveLoadout).mockReturnValue(loadout);

  const { runtime } = setup();

  runtime.capacity = 1;

  const first = await launch(runtime, {});

  expect(first.isError).not.toBe(true);

  const emptied = createHcFake();

  emptied.reply('ls', JSON.stringify({ terminals: [] }));
  emptied.reply('get', JSON.stringify({ address: manager, state: 'live', labels: {} }));

  emptied.replyConnect('hello', 1, {
    generation: 1,
    version: 'test',
    core: { id: 'core', name: 'core' },
    framed: false,
    methods: [],
    features: [],
  });

  emptied.replyConnect('terminal.run', 2, {
    address: 't-worker-2',
    state: 'live',
    parent: manager,
  });

  runtime.hc = { exec: emptied.exec, connect: emptied.connect, cwd: runtime.hc.cwd };

  const second = await launch(runtime, {});

  expect(second.isError).not.toBe(true);
  expect(terminalRun(emptied)).toBeDefined();
});

const heldManagerRead = (runtime: LaunchRuntime) => {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const originalExec = runtime.hc.exec;

  runtime.hc.exec = async (command, commandArguments, execOptions) => {
    if (command === 'hc' && commandArguments[0] === 'get' && commandArguments.at(-1) === manager) {
      entered.resolve(undefined);
      await release.promise;
    }

    return originalExec(command, commandArguments, execOptions);
  };

  return {
    entered: entered.promise,
    release: () => {
      release.resolve(undefined);
    },
  };
};

it('creates the scratch folder after the manager terminal read', async () => {
  const { fake, runtime, scratchExistedAtRun } = setup();
  const held = heldManagerRead(runtime);

  const pending = launch(runtime, {});

  await held.entered;

  const createdWhileWaiting = scratchNames(runtime.agentDirectory);

  held.release();

  const result = await pending;

  expect(createdWhileWaiting).toEqual([]);
  expect(result.isError).not.toBe(true);
  expect(scratchExistedAtRun()).toBe(true);
  expect(terminalRun(fake)).toBeDefined();
  expect(scratchNames(runtime.agentDirectory)).toHaveLength(1);
});

it('leaves no scratch folder when the signal aborts during the manager read', async () => {
  const { fake, runtime } = setup();
  const controller = new AbortController();
  const held = heldManagerRead(runtime);

  const pending = launch(runtime, {}, controller.signal);

  await held.entered;
  controller.abort();
  held.release();

  const result = await pending;

  expect(result.isError).toBe(true);
  expect(terminalRun(fake)).toBeUndefined();
  expect(scratchNames(runtime.agentDirectory)).toEqual([]);
});

it('refuses a foreground launch whose signal aborts during the manager label read', async () => {
  const { fake, runtime } = setup({ managerLabels: { 'herdr.space': 'space-1' } });

  const packagedLoadout = {
    ...fixtureLoadout(runtime.agentDirectory),
    packages: ['npm:review-package'],
  };

  vi.mocked(loadouts.resolveLoadout).mockReturnValue(packagedLoadout);

  const controller = new AbortController();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const originalExec = runtime.hc.exec;

  runtime.capacity = 1;

  runtime.packageManager = (() => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: async ([source = '']: string[]) => ({
      extensions: [
        {
          path: source,
          enabled: true,
          metadata: {
            source,
            scope: 'temporary',
            origin: 'package',
            packageRoot: writeFakePackage(runtime.agentDirectory, source),
          },
        },
      ],
      skills: [],
      prompts: [],
      themes: [],
    }),
  })) as unknown as NonNullable<LaunchRuntime['packageManager']>;

  runtime.hc.exec = async (command, commandArguments, execOptions) => {
    if (command === 'hc' && commandArguments[0] === 'get' && commandArguments.at(-1) === manager) {
      entered.resolve(undefined);
      await release.promise;
    }

    return originalExec(command, commandArguments, execOptions);
  };

  const pending = launch(runtime, {}, controller.signal);

  await entered.promise;
  controller.abort();
  release.resolve(undefined);

  const result = await pending;

  expect(result.isError).toBe(true);
  expect(terminalRun(fake)).toBeUndefined();
  expect(fake.connectCalls).toHaveLength(0);
  expect(snapshotNames(runtime.agentDirectory)).toEqual([]);

  vi.mocked(loadouts.resolveLoadout).mockReturnValue(loadout);

  const second = await launch(runtime, {});

  expect(second.isError).not.toBe(true);
});

it('frees an unclear reservation once hc shows that terminal finished', async () => {
  const state = uncertainSetup('read_failed');
  let labels: Record<string, string> = {};

  state.runtime.hc.connect = async (lines) => {
    const request = JSON.parse(lines[1] ?? '') as {
      params: { labels: Record<string, string> };
    };

    labels = request.params.labels;
    state.fake.fail('ls', 'temporary lookup failure', 1);

    throw new HcError('read_failed', 'lost launch reply');
  };

  const first = await launch(state.runtime, {});

  expect(first.isError).toBe(true);
  expect(first.content[0]?.text).toContain('unclear');

  const finished = createHcFake();

  const finishedTerminal = {
    address: 'worker',
    name: 'worker',
    state: 'finished',
    parent: manager,
    labels,
  };

  finished.reply('ls', JSON.stringify({ terminals: [finishedTerminal] }));
  finished.reply('get', JSON.stringify(finishedTerminal));

  finished.replyConnect('hello', 1, {
    generation: 1,
    version: 'test',
    core: { id: 'core', name: 'core' },
    framed: false,
    methods: [],
    features: [],
  });

  finished.replyConnect('terminal.run', 2, {
    address: 't-worker-2',
    state: 'live',
    parent: manager,
  });

  state.runtime.hc = { exec: finished.exec, connect: finished.connect, cwd: state.runtime.hc.cwd };

  const second = await launch(state.runtime, {});

  expect(second.isError).not.toBe(true);
  expect(terminalRun(finished)).toBeDefined();
});

it('refuses a launch without HC_TERMINAL_ID', async () => {
  vi.mocked(loadouts.resolveLoadout).mockReturnValue(loadout);

  const { runtime } = setup();

  vi.stubEnv('HC_TERMINAL_ID', '');

  const result = await launch(runtime, {});

  expect(result).toMatchObject({ isError: true });
  expect(result.content[0]?.text).toContain('HC_TERMINAL_ID');
});
