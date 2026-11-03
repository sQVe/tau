import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { fixtureLoadout } from '../src/extensions/subagents/fixtures/loadout.js';
import { Admission, executeLaunch } from '../src/extensions/subagents/launch.js';
import type { LaunchRuntime } from '../src/extensions/subagents/launch.js';
import * as loadouts from '../src/extensions/subagents/loadout.js';
import { runWithEnvironment } from '../src/hc/connect.js';
import { get } from '../src/hc/hc.js';
import { startHcSession } from './hcSessionHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

vi.mock(import('../src/extensions/subagents/loadout.js'), { spy: true });

it('launches a background worker as an hc child with tau labels', async () => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const agentDirectory = mkdtempSync(join(tmpdir(), 'tau-launch-agent-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const managerTerminal = await runWithEnvironment(hc.runtime, {
    argv: ['sleep', '60'],
    name: 'manager',
    env: {},
  });

  vi.stubEnv('HC_TERMINAL_ID', managerTerminal.address);

  const loadout = fixtureLoadout(hc.root);

  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({ loadout, routing: undefined });

  const runtime: LaunchRuntime = {
    pi: { getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI,
    hc: hc.runtime,
    capacity: 4,
    admission: new Admission(),
    readSkillTools: () => ({}),
    agentDirectory,
    processEnvironment: { ...hc.environment, PATH: process.env.PATH },
    buildCommand: () => ['sleep', '60'],
  };

  const result = await executeLaunch(
    runtime,
    {
      parameters: {
        task: 'Inspect the counters.',
        profile: 'worker',
        label: 'Inspect counters',
        visibility: 'background',
      },
      startedAt: { wall: Date.now(), monotonic: performance.now() },
      parentSession: join(agentDirectory, 'parent.jsonl'),
    },
    undefined,
    { sessionManager: { getSessionId: () => 'parent-one' } } as unknown as ExtensionContext,
  );

  expect(result.isError).not.toBe(true);
  const address = result.details?.address;

  if (address === undefined) {
    throw new Error('Launch returned no address.');
  }

  const worker = await get(hc.runtime, address);

  expect(worker.parent).toBe(managerTerminal.address);

  expect(worker.labels).toMatchObject({
    'tau.profile': 'worker',
    'tau.model': 'faux/test',
    'tau.task': 'Inspect counters',
  });

  expect(worker.labels?.['tau.assignment']).toContain('/assignments/');
  expect(worker.labels?.['tau.deadline']).toMatch(/^\d+$/);
  expect(worker.labels?.['herdr.space']).toBeUndefined();
  expect(worker.labels?.['herdr.tab']).toBeUndefined();
});

it('gives a launched worker the private session paths when the manager environment holds real ones', async () => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const agentDirectory = mkdtempSync(join(tmpdir(), 'tau-launch-agent-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const managerTerminal = await runWithEnvironment(hc.runtime, {
    argv: ['sleep', '60'],
    name: 'manager',
    env: {},
  });

  vi.stubEnv('HC_TERMINAL_ID', managerTerminal.address);

  const workerDirectory = temporaryDirectory(onTestFinished, 'tau-launch-worker-');
  const environmentPath = join(workerDirectory, 'worker-environment');

  const loadout = { ...fixtureLoadout(hc.root), cwd: workerDirectory };

  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({ loadout, routing: undefined });

  const realRuntimeDirectory = process.env['XDG_RUNTIME_DIR'] ?? '/run/user/1000';
  const realStateHome = process.env['XDG_STATE_HOME'] ?? '/home/user/.local/state';

  const runtime: LaunchRuntime = {
    pi: { getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI,
    hc: hc.runtime,
    capacity: 4,
    admission: new Admission(),
    readSkillTools: () => ({}),
    agentDirectory,
    processEnvironment: {
      ...hc.environment,
      XDG_RUNTIME_DIR: realRuntimeDirectory,
      XDG_STATE_HOME: realStateHome,
    },
    // The shell creates the target before env writes to it, so the file appears whole only after mv.
    buildCommand: () => [
      'sh',
      '-c',
      `env > ${environmentPath}.partial && mv ${environmentPath}.partial ${environmentPath}; sleep 60`,
    ],
  };

  const result = await executeLaunch(
    runtime,
    {
      parameters: {
        task: 'Inspect the environment.',
        profile: 'worker',
        visibility: 'background',
      },
      startedAt: { wall: Date.now(), monotonic: performance.now() },
      parentSession: join(agentDirectory, 'parent.jsonl'),
    },
    undefined,
    { sessionManager: { getSessionId: () => 'parent-environment' } } as unknown as ExtensionContext,
  );

  expect(result.isError).not.toBe(true);

  await vi.waitFor(() => {
    expect(existsSync(environmentPath)).toBe(true);
  });

  const environment = readFileSync(environmentPath, 'utf8');

  expect(environment).toContain(`XDG_RUNTIME_DIR=${hc.environment['XDG_RUNTIME_DIR']}\n`);
  expect(environment).toContain(`XDG_STATE_HOME=${hc.environment['XDG_STATE_HOME']}\n`);
});
