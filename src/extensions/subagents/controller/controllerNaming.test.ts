import { readdirSync } from 'node:fs';

import { expect, it, vi, onTestFinished as afterTest } from 'vitest';

import * as names from '../names.js';
import { readTask, recordEvent } from '../records.js';
import { WorkerController } from './controller.js';
import { setup } from './fixtures/controllerFixture.js';

vi.mock(import('node:fs'), { spy: true });

it('retains friendly names and avoids retained and live collisions', async ({ onTestFinished }) => {
  const suffix = vi.spyOn(names, 'nameSuffix').mockReturnValue('aa');
  let live: unknown[] = [];

  const { controller, input, directory, calls } = setup(onTestFinished, 0, async (argumentsList) =>
    argumentsList[0] === 'agent' && argumentsList[1] === 'list'
      ? JSON.stringify({ result: { type: 'agent_list', agents: live } })
      : '',
  );

  const first = await controller.launch(input);
  expect(readTask(first.directory)).toMatchObject({ name: 'worker-aa' });

  recordEvent(first.directory, first.taskId, 'cleanup', {
    detail: 'Pane removed.',
    stopped: true,
  });

  live = [
    { pane_id: 'elsewhere', name: 'worker-bb' },
    { pane_id: 'unnamed', name: null },
  ];

  suffix.mockReturnValueOnce('aa').mockReturnValueOnce('bb').mockReturnValue('cc');
  const second = await controller.launch(input);

  expect(readTask(second.directory)).toMatchObject({ name: 'worker-cc' });

  expect(calls.filter((call) => call[1] === 'rename').map((call) => call[3])).toEqual([
    'worker-aa (test)',
    'worker-cc (test)',
  ]);

  controller.close();
  const recovered = new WorkerController(directory);

  expect(recovered.status(first.taskId, input.parentSessionId)).toMatchObject({
    name: 'worker-aa',
  });

  recovered.close();
});

it.for(['reviewer', 'checker', 'qa'])(
  'names a %s launch after its profile',
  async (profile, { onTestFinished }) => {
    vi.spyOn(names, 'nameSuffix').mockReturnValue('aa');
    const { controller, input, calls } = setup(onTestFinished);

    const status = await controller.launch({
      ...input,
      loadout: { ...input.loadout, profile, role: 'investigation' },
    });

    expect(readTask(status.directory).name).toBe(`${profile}-aa`);
    expect(calls.find((call) => call[1] === 'rename')?.[3]).toBe(`${profile}-aa (test)`);
  },
);

it.for([
  ['editing', 'foreground'],
  ['investigation', 'background'],
] as const)(
  'shows %s workers in the %s by default',
  async ([role, visibility], { onTestFinished }) => {
    const { controller, input } = setup(onTestFinished);

    const status = await controller.launch({ ...input, loadout: { ...input.loadout, role } });

    expect(status.placement).toEqual({ visibility });
  },
);

it('names a custom profile launch after its role', async ({ onTestFinished }) => {
  vi.spyOn(names, 'nameSuffix').mockReturnValue('aa');
  const { controller, input } = setup(onTestFinished);

  const status = await controller.launch({
    ...input,
    loadout: { ...input.loadout, profile: 'researcher', role: 'investigation' },
  });

  expect(readTask(status.directory).name).toBe('scout-aa');
});

it('allocates distinct names for parallel launches and refuses bounded exhaustion', async ({
  onTestFinished,
}) => {
  const suffix = vi
    .spyOn(names, 'nameSuffix')
    .mockReturnValueOnce('aa')
    .mockReturnValueOnce('aa')
    .mockReturnValue('bb');

  const { controller, client, directory, input, calls } = setup(onTestFinished);
  const parallel = new WorkerController(directory, client);

  onTestFinished(() => {
    parallel.close();
  });

  const launched = await Promise.all([controller.launch(input), parallel.launch(input)]);

  expect(
    launched
      .map((status) => readTask(status.directory).name)
      .toSorted((left, right) => String(left).localeCompare(String(right))),
  ).toEqual(['worker-aa', 'worker-bb']);

  suffix.mockClear().mockReturnValue('aa');
  const starts = calls.filter((call) => call[0] === 'layout').length;

  await expect(controller.launch(input)).rejects.toThrow('32');
  expect(suffix).toHaveBeenCalledTimes(32);
  expect(calls.filter((call) => call[0] === 'layout')).toHaveLength(starts);
});

it.each(['failure', 'malformed'] as const)(
  'refuses naming when live listing is %s',
  async (kind) => {
    const { controller, input, calls } = setup(afterTest, 0, async (argumentsList) => {
      if (argumentsList[1] !== 'list') {
        return '';
      }

      if (kind === 'failure') {
        throw new Error('Listing failed.');
      }

      return JSON.stringify({
        result: { type: 'agent_list', agents: [{ pane_id: 'other', name: 42 }] },
      });
    });

    await expect(controller.launch(input)).rejects.toThrow(/listing|Listing/);
    expect(calls.some((call) => call[1] === 'split')).toBe(false);
  },
);

it.each(['cancelled', 'expired', 'closed'] as const)(
  'keeps naming inside the original launch budget when %s',
  async (kind) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const listed = Promise.withResolvers<number>();
    const release = Promise.withResolvers<string>();
    const abort = new AbortController();

    const { controller, input, calls, directory } = setup(
      afterTest,
      0,
      async (argumentsList, budget) => {
        if (argumentsList[1] === 'list') {
          listed.resolve(budget);

          return release.promise;
        }

        return '';
      },
    );

    const pending = controller.launch(input, abort.signal);
    expect(await listed.promise).toBeLessThanOrEqual(7500);

    if (kind === 'cancelled') {
      abort.abort(new Error('Name listing cancelled.'));
    } else if (kind === 'closed') {
      controller.close();
    } else {
      clock.mockReturnValue(10000);
    }

    release.resolve(JSON.stringify({ result: { type: 'agent_list', agents: [] } }));

    await expect(pending).rejects.toThrow(/cancelled|aborted|budget expired/);
    expect(calls.map((call) => call[1])).toEqual(['list']);
    expect(readdirSync(directory)).toEqual(['parent.jsonl']);
  },
);
