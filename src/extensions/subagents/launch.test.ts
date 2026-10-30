import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { declinedExec } from '../../../tests/declinedExecFake.js';
import type { WorkerController } from './controller/controller.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { executeInitialLaunch } from './launch.js';
import type { LaunchParameters } from './launchParameters.js';
import * as loadouts from './loadout.js';

vi.mock(import('./loadout.js'), { spy: true });

afterEach(() => {
  vi.restoreAllMocks();
});

const loadout = fixtureLoadout('/work');

const routing = {
  model: 'faux/routed',
  shadowPick: 'faux/routed',
  confidenceCutoff: 0.7,
  ticketSent: false,
};

const status = { taskId: 'task-one', state: 'running', deadline: 5000 };

const launchWith = async (parameters: LaunchParameters, routed: typeof routing | undefined) => {
  const inputs: unknown[] = [];

  const controller = {
    launch: async (input: unknown) => {
      inputs.push(input);

      return status;
    },
  } as unknown as WorkerController;

  vi.mocked(loadouts.resolveRoutedLoadout).mockResolvedValue({ loadout, routing: routed });

  const result = await executeInitialLaunch(
    {
      pi: { getCommands: () => [], exec: declinedExec },
      getController: () => Promise.resolve(controller),
      refuseCapacity: () => {},
    },
    { parameters, startedAt: { wall: 1, monotonic: 2 }, parentSession: '/work/parent.jsonl' },
    undefined,
    {
      cwd: '/work',
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => 'parent-one' },
    } as unknown as ExtensionContext,
  );

  return { result, inputs };
};

const launchInput = {
  task: 'Fix the counts.',
  loadout,
  timeout: 3_600_000,
  startedAt: { wall: 1, monotonic: 2 },
  parentSession: '/work/parent.jsonl',
  parentSessionId: 'parent-one',
};

it('cancels the launch wait without cancelling shared controller resume', async () => {
  const resumed = Promise.withResolvers<WorkerController>();
  const resuming = Promise.withResolvers<undefined>();
  const abort = new AbortController();
  const launch = vi.fn<WorkerController['launch']>();
  const commands = vi.fn<() => []>(() => []);
  let failure: unknown;

  const pending = executeInitialLaunch(
    {
      pi: { getCommands: commands, exec: declinedExec },
      getController: () => {
        resuming.resolve(undefined);

        return resumed.promise;
      },
      refuseCapacity: () => {},
    },
    {
      parameters: { task: 'Inspect.', profile: 'scout', timeoutSeconds: 10 },
      startedAt: { wall: Date.now(), monotonic: performance.now() },
      parentSession: '/work/parent.jsonl',
    },
    abort.signal,
    { cwd: '/work' } as ExtensionContext,
  ).catch((error: unknown) => {
    failure = error;
  });

  const reason = new Error('Caller cancelled the launch.');

  await resuming.promise;
  abort.abort(reason);

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(failure).toBe(reason);
  await pending;

  resumed.resolve({ launch } as unknown as WorkerController);

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(commands).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

it('passes the caller settings and route to the controller', async () => {
  const { inputs } = await launchWith(
    {
      task: 'Fix the counts.',
      profile: 'worker',
      acceptance: ['Counts match.'],
      label: 'Fix counts',
      visibility: 'background',
    },
    routing,
  );

  expect(inputs).toStrictEqual([
    {
      ...launchInput,
      acceptance: ['Counts match.'],
      label: 'Fix counts',
      routing,
      visibility: 'background',
    },
  ]);
});

it('leaves unset caller settings out of the controller launch', async () => {
  const { inputs } = await launchWith({ task: 'Fix the counts.', profile: 'worker' }, undefined);

  expect(inputs).toStrictEqual([launchInput]);
});

it('returns the launch status to the model and the caller', async () => {
  const { result } = await launchWith({ task: 'Fix the counts.', profile: 'worker' }, undefined);
  const [part] = result.content;

  expect(result.content).toHaveLength(1);
  expect(part?.type).toBe('text');
  expect(JSON.parse(part?.text ?? '')).toMatchObject(status);
  expect(result.details).toBe(status);
});
