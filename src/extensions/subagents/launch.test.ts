import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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
import { skillTools } from '../../skillTools.js';
import { writeAssignment } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { writeFakePackage } from './fixtures/packageCache.js';
import { Admission, executeLaunch } from './launch.js';
import type { LaunchRuntime } from './launch.js';
import type { LaunchParameters } from './launchParameters.js';
import * as loadouts from './loadout.js';
import * as packageSnapshot from './packageSnapshot.js';

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
      return request.params as { name: string; labels: Record<string, string> };
    }
  }

  return undefined;
};

const succeeded = (value: unknown) => ({
  code: 0,
  killed: false,
  stdout: JSON.stringify(value),
  stderr: '',
});

const setup = (
  options: { children?: HcTerminal[]; managerLabels?: Record<string, string> } = {},
): { fake: HcFake; runtime: LaunchRuntime; refuseCapacity: ReturnType<typeof vi.fn> } => {
  const directory = temporaryDirectory(onTestFinished, 'tau-launch-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fake = createHcFake();

  const managerTerminal: HcTerminal = {
    address: manager,
    state: 'live',
    labels: options.managerLabels ?? {},
  };

  const children = options.children ?? [];
  const launched: HcTerminal[] = [];

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

      return Promise.resolve(
        terminal === undefined
          ? { code: 1, killed: false, stdout: '', stderr: 'not_found' }
          : succeeded(terminal),
      );
    }

    return fake.exec(command, commandArguments, execOptions);
  };

  const connect: Connect = (lines, connectOptions) => {
    const request = lines
      .map(
        (line) =>
          JSON.parse(line) as { method: string; params?: { labels?: Record<string, string> } },
      )
      .find((message) => message.method === 'terminal.run');

    if (request !== undefined) {
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
    pi: { getCommands: () => [] } as unknown as ExtensionAPI,
    hc: { exec, connect, cwd: directory },
    capacity: 2,
    admission: new Admission(),
    skillTools,
    agentDirectory: directory,
    processEnvironment: { PATH: process.env.PATH },
    refuseCapacity,
  };

  return { fake, runtime, refuseCapacity };
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
      parameters: { task: 'Fix the counts.', profile: 'worker', ...parameters },
      startedAt: { wall: 1000, monotonic: 2 },
      parentSession: '/work/parent.jsonl',
    },
    signal,
    context,
  );

const uncertainSetup = (
  kind: 'missing_reply' | 'read_failed' | 'spawn_failed',
  packages: string[] = [],
) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-launch-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const uncertainLoadout = { ...fixtureLoadout(directory), packages };
  const fake = createHcFake();
  let launches = 0;

  fake.reply('ls', JSON.stringify({ terminals: [] }));

  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({
    loadout: uncertainLoadout,
    routing: undefined,
  });

  const runtime: LaunchRuntime = {
    pi: { getCommands: () => [] } as unknown as ExtensionAPI,
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
    skillTools,
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

const snapshotNames = (directory: string): string[] => {
  const root = join(directory, 'tmp', 'tau-worker-packages');

  return existsSync(root) ? readdirSync(root) : [];
};

it('starts one of two concurrent launches and refuses the other', async () => {
  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({ loadout, routing: undefined });

  const { fake, runtime, refuseCapacity } = setup({ children: [existingChild] });

  const [first, second] = await Promise.all([
    launch(runtime, { visibility: 'background' }),
    launch(runtime, { visibility: 'background' }),
  ]);

  expect(first.isError).not.toBe(true);
  expect(second).toMatchObject({ isError: true, terminate: true });
  expect(fake.connectCalls).toHaveLength(1);
  expect(refuseCapacity).toHaveBeenCalledOnce();
});

it('refuses an editing launch without acceptance criteria', async () => {
  vi.mocked(loadouts.resolveRoutedLoadout).mockRejectedValue(
    new Error(
      'An editing worker needs acceptance criteria. Pass acceptance with at least one item.',
    ),
  );

  const { runtime } = setup();
  const result = await launch(runtime, {});

  expect(result).toMatchObject({ isError: true });
  expect(result.content[0]?.text).toContain('acceptance criteria');
});

it('reports a failed loadout check', async () => {
  vi.mocked(loadouts.resolveRoutedLoadout).mockRejectedValue(
    new Error('Worker profile package failed to load.'),
  );

  const { runtime } = setup();
  const result = await launch(runtime, {});

  expect(result).toMatchObject({ isError: true });
  expect(result.content[0]?.text).toContain('package');
});

it('writes the tau labels and no herdr labels in background mode', async () => {
  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({ loadout, routing: undefined });

  const { fake, runtime } = setup({ managerLabels: { 'herdr.space': 'space-1' } });

  const result = await launch(runtime, { visibility: 'background' });

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

it('copies the manager herdr labels in foreground mode', async () => {
  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({ loadout, routing: undefined });

  const { fake, runtime } = setup({
    managerLabels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2' },
  });

  await launch(runtime, { visibility: 'foreground' });
  const request = terminalRun(fake);

  expect(request?.labels['herdr.space']).toBe('space-1');
  expect(request?.labels['herdr.tab']).toBe('tab-2');
});

it.each(['missing_reply', 'read_failed'] as const)(
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

    const result = await launch(state.runtime, { visibility: 'background' });

    expect(result.isError).not.toBe(true);
    expect(result.details?.address).toBe('worker');
  },
);

it('frees the slot when an unclear launch finds no worker', async () => {
  const state = uncertainSetup('missing_reply');

  const first = await launch(state.runtime, { visibility: 'background' });
  const second = await launch(state.runtime, { visibility: 'background' });

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
  'keeps the reservation and snapshot when reconciliation %s fails',
  async (failure) => {
    const state = reconciliationFailureSetup(failure);

    const result = await launch(state.runtime, { visibility: 'background' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('unclear');
    expect(result.content[0]?.text).toContain('hc ls');
    expect(snapshotNames(state.directory)).toHaveLength(1);

    const empty = createHcFake();

    empty.reply('ls', JSON.stringify({ terminals: [] }));

    state.runtime.hc.exec = empty.exec;

    const second = await launch(state.runtime, { visibility: 'background' });

    expect(second.isError).toBe(true);
    expect(second.content[0]?.text).toContain('capacity full');
  },
);

it('removes the snapshot after a definite launch failure', async () => {
  const state = uncertainSetup('spawn_failed', ['npm:review-package']);
  const result = await launch(state.runtime, { visibility: 'background' });

  expect(result.isError).toBe(true);
  expect(snapshotNames(state.directory)).toEqual([]);
});

it('keeps the cleanup error in the launch error when snapshot removal also fails', async () => {
  const cleanupError = 'Package snapshot root is redirected. Cleanup refused.';

  vi.mocked(packageSnapshot.removeSnapshotDirectory).mockResolvedValueOnce(cleanupError);
  const state = uncertainSetup('spawn_failed', ['npm:review-package']);
  const result = await launch(state.runtime, { visibility: 'background' });

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('launch failure');
  expect(result.content[0]?.text).toContain(cleanupError);
});

it('removes the snapshot after a failed assignment write', async () => {
  const state = uncertainSetup('read_failed', ['npm:review-package']);

  mkdirSync(state.directory, { recursive: true });
  writeFileSync(join(state.directory, 'tau'), 'blocked');

  const result = await launch(state.runtime, { visibility: 'background' });

  expect(result.isError).toBe(true);
  expect(snapshotNames(state.directory)).toEqual([]);
});

it('refuses a launch aborted while it waits for admission', async () => {
  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({ loadout, routing: undefined });

  const { fake, runtime } = setup();
  const controller = new AbortController();
  const release = Promise.withResolvers<undefined>();
  const held = runtime.admission.run(() => release.promise);
  const pending = launch(runtime, { model: 'faux/test' }, controller.signal);

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

  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({
    loadout: packagedLoadout,
    routing: undefined,
  });

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

  const result = await launch(runtime, { model: 'faux/test' }, controller.signal);

  expect(result.isError).toBe(true);
  expect(terminalRun(fake)).toBeUndefined();
  expect(fake.connectCalls).toHaveLength(0);

  expect(snapshotNames(runtime.agentDirectory)).toEqual([]);

  vi.mocked(writeAssignment).mockRestore();

  const second = await launch(runtime, { visibility: 'background' });

  expect(second.isError).not.toBe(true);
  expect(terminalRun(fake)).toBeDefined();
});

it('frees a confirmed slot when hc removed the child before the next launch', async () => {
  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({ loadout, routing: undefined });

  const { runtime } = setup();

  runtime.capacity = 1;

  const first = await launch(runtime, { visibility: 'background' });

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

  const second = await launch(runtime, { visibility: 'background' });

  expect(second.isError).not.toBe(true);
  expect(terminalRun(emptied)).toBeDefined();
});

it('refuses a launch without HC_TERMINAL_ID', async () => {
  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({ loadout, routing: undefined });

  const { runtime } = setup();

  vi.stubEnv('HC_TERMINAL_ID', '');

  const result = await launch(runtime, {});

  expect(result).toMatchObject({ isError: true });
  expect(result.content[0]?.text).toContain('HC_TERMINAL_ID');
});
