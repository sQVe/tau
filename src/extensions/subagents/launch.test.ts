import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { HcError } from '../../hc/hc.js';
import { skillTools } from '../../skillTools.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { writeFakePackage } from './fixtures/packageCache.js';
import { Admission, executeLaunch } from './launch.js';
import type { LaunchRuntime } from './launch.js';
import type { LaunchParameters } from './launchParameters.js';
import * as loadouts from './loadout.js';

vi.mock(import('./loadout.js'), { spy: true });

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

const setup = (
  options: { children?: unknown[]; managerLabels?: Record<string, string> } = {},
): { fake: HcFake; runtime: LaunchRuntime; refuseCapacity: ReturnType<typeof vi.fn> } => {
  const directory = temporaryDirectory(onTestFinished, 'tau-launch-');

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fake = createHcFake();

  const managerTerminal = {
    address: manager,
    state: 'live',
    labels: options.managerLabels ?? {},
  };

  fake.reply('ls', JSON.stringify({ terminals: options.children ?? [] }));

  fake.reply(
    'get',
    JSON.stringify((options.children ?? []).length > 0 ? existingChild : managerTerminal),
  );

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

  const refuseCapacity = vi.fn<() => void>();

  const runtime: LaunchRuntime = {
    pi: { getCommands: () => [] } as unknown as ExtensionAPI,
    hc: { exec: fake.exec, connect: fake.connect, cwd: directory },
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

const launch = (runtime: LaunchRuntime, parameters: Partial<LaunchParameters> = {}) =>
  executeLaunch(
    runtime,
    {
      parameters: { task: 'Fix the counts.', profile: 'worker', ...parameters },
      startedAt: { wall: 1000, monotonic: 2 },
      parentSession: '/work/parent.jsonl',
    },
    undefined,
    context,
  );

// A launch whose `terminal.run` cannot be confirmed. `connect` rejects before `hc` replies.
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

it('removes the snapshot after a failed assignment write', async () => {
  const state = uncertainSetup('read_failed', ['npm:review-package']);

  mkdirSync(state.directory, { recursive: true });
  writeFileSync(join(state.directory, 'tau'), 'blocked');

  const result = await launch(state.runtime, { visibility: 'background' });

  expect(result.isError).toBe(true);
  expect(snapshotNames(state.directory)).toEqual([]);
});

it('refuses a launch without HC_TERMINAL_ID', async () => {
  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({ loadout, routing: undefined });

  const { runtime } = setup();

  vi.stubEnv('HC_TERMINAL_ID', '');

  const result = await launch(runtime, {});

  expect(result).toMatchObject({ isError: true });
  expect(result.content[0]?.text).toContain('HC_TERMINAL_ID');
});
