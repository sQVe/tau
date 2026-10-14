import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi, onTestFinished as afterTest } from 'vitest';

import type { WorkerNotice } from '../presentation.js';
import { readEvent, readTask, recordEvent } from '../records.js';
import * as records from '../records.js';
import { WorkerCapacityFullError, WorkerController } from './controller.js';
import { setup } from './fixtures/controllerFixture.js';

vi.mock(import('node:fs'), { spy: true });

it('reattaches accepted work and cancels it without replacing saved records', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);

  const launched = await fixture.controller.launch(fixture.input);
  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');

  const saved = readdirSync(launched.directory).map((name) => ({
    name,
    bytes: readFileSync(join(launched.directory, name)),
  }));

  const recovered = new WorkerController(fixture.directory, fixture.client);

  onTestFinished(() => {
    recovered.close();
  });

  await recovered.resume('parent-id');

  expect(recovered.status(launched.taskId, 'parent-id').state).toBe('running');
  expect(recovered.owns(launched.taskId)).toBe(true);

  for (const { name, bytes } of saved) {
    expect(readFileSync(join(launched.directory, name))).toEqual(bytes);
  }

  const stopped = await recovered.cancel(launched.taskId, 'parent-id');

  expect(stopped).toMatchObject({ state: 'stopped', outcome: 'cancelled' });
  expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(true);
  expect(fixture.calls).toContainEqual(['pane', 'close', 'worker-1']);
  expect(fixture.calls.filter((call) => call[0] === 'layout')).toHaveLength(1);

  for (const { name, bytes } of saved) {
    expect(readFileSync(join(launched.directory, name))).toEqual(bytes);
  }
});

it('skips saved workers without herdr calls when the reattach capacity is full', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  vi.stubEnv('TAU_SUBAGENT_CAP', '1');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const fixture = setup(onTestFinished);
  const saved = await fixture.controller.launch(fixture.input);
  fixture.controller.close();
  const recovered = new WorkerController(fixture.directory, fixture.client);

  onTestFinished(() => {
    recovered.close();
  });

  const live = await recovered.launch(fixture.input);
  const callsBefore = fixture.calls.length;
  const recordsBefore = readdirSync(saved.directory);

  await recovered.resume('parent-id');

  expect(recovered.owns(live.taskId)).toBe(true);
  expect(recovered.owns(saved.taskId)).toBe(false);
  expect(fixture.calls).toHaveLength(callsBefore);
  expect(readdirSync(saved.directory)).toEqual(recordsBefore);
});

it('reserves capacity while a saved worker inspection is pending', async ({ onTestFinished }) => {
  vi.useFakeTimers();
  vi.stubEnv('TAU_SUBAGENT_CAP', '1');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const fixture = setup(onTestFinished);
  const saved = await fixture.controller.launch(fixture.input);
  fixture.controller.close();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let paused = false;

  const recovered = new WorkerController(
    fixture.directory,
    async (argumentsList, budget, signal) => {
      if (argumentsList[0] === 'agent' && argumentsList[1] === 'get' && !paused) {
        paused = true;
        entered.resolve(undefined);
        await release.promise;
      }

      return fixture.client(argumentsList, budget, signal);
    },
  );

  onTestFinished(() => {
    recovered.close();
  });

  const resuming = recovered.resume('parent-id');
  await entered.promise;
  const recordsBefore = readdirSync(fixture.directory);
  const startsBefore = fixture.calls.filter((call) => call[0] === 'layout').length;
  const launched = await recovered.launch(fixture.input).catch((error: unknown) => error);
  release.resolve(undefined);
  await resuming;

  expect(launched).toBeInstanceOf(WorkerCapacityFullError);
  expect(String(launched)).toContain('capacity full');
  expect(readdirSync(fixture.directory)).toEqual(recordsBefore);
  expect(fixture.calls.filter((call) => call[0] === 'layout')).toHaveLength(startsBefore);
  expect(recovered.owns(saved.taskId)).toBe(true);
});

it('stops a saved worker while its resume inspection is pending', async ({ onTestFinished }) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);

  const saved = await fixture.controller.launch(fixture.input);
  fixture.controller.close();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let paused = false;

  const recovered = new WorkerController(
    fixture.directory,
    async (argumentsList, budget, signal) => {
      if (argumentsList[0] === 'agent' && argumentsList[1] === 'get' && !paused) {
        paused = true;
        entered.resolve(undefined);
        await release.promise;
      }

      return fixture.client(argumentsList, budget, signal);
    },
  );

  onTestFinished(() => {
    recovered.close();
  });

  const resuming = recovered.resume('parent-id');
  await entered.promise;

  await recovered.stopAll('reload');
  release.resolve(undefined);
  await resuming;

  expect(fixture.fake.calls).toContainEqual(['pane', 'close', 'worker-1']);

  expect(readEvent(saved.directory, saved.taskId, 'cleanup')?.stopped).toBe(true);
  expect(recovered.status(saved.taskId, 'parent-id').state).toBe('stopped');
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps a saved worker owned while cancel stops it during resume inspection', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);

  const saved = await fixture.controller.launch(fixture.input);
  fixture.controller.close();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let paused = false;

  const recovered = new WorkerController(
    fixture.directory,
    async (argumentsList, budget, signal) => {
      if (argumentsList[0] === 'agent' && argumentsList[1] === 'get' && !paused) {
        paused = true;
        entered.resolve(undefined);
        await release.promise;
      }

      return fixture.client(argumentsList, budget, signal);
    },
  );

  onTestFinished(() => {
    recovered.close();
  });

  const resuming = recovered.resume('parent-id');
  await entered.promise;
  const cancelling = recovered.cancel(saved.taskId, 'parent-id');
  release.resolve(undefined);
  await resuming;
  const ownedDuringCleanup = recovered.owns(saved.taskId);
  const repeated = recovered.cancel(saved.taskId, 'parent-id');
  await Promise.all([cancelling, repeated]);

  expect(ownedDuringCleanup).toBe(true);
  expect(fixture.fake.calls.filter((call) => call[1] === 'close')).toHaveLength(1);
  expect(readEvent(saved.directory, saved.taskId, 'cleanup')?.stopped).toBe(true);
});

it('releases the handle and capacity after failed reattach verification', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  vi.stubEnv('TAU_SUBAGENT_CAP', '1');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const fixture = setup(onTestFinished);
  const saved = await fixture.controller.launch(fixture.input);
  fixture.controller.close();
  fixture.fake.state.session = 'different-session';
  const recordsBefore = readdirSync(saved.directory);
  const recovered = new WorkerController(fixture.directory, fixture.client);

  onTestFinished(() => {
    recovered.close();
  });

  await recovered.resume('parent-id');

  expect(recovered.owns(saved.taskId)).toBe(false);
  expect(recovered.status(saved.taskId, 'parent-id').state).toBe('notOwned');
  expect(readdirSync(saved.directory)).toEqual(recordsBefore);
  expect(fixture.calls.filter((call) => call[1] === 'close')).toEqual([]);
  const launched = await recovered.launch(fixture.input);

  expect(recovered.owns(launched.taskId)).toBe(true);
  expect(launched.state).toBe('starting');
});

it.each(['stopping', 'cancelled', 'timeout'])(
  'finishes cleanup after the previous parent saved %s',
  async (kind) => {
    vi.useFakeTimers();
    const fixture = setup(afterTest);

    const launched = await fixture.controller.launch(fixture.input);
    recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');
    recordEvent(launched.directory, launched.taskId, kind, 'Cleanup interrupted.');
    fixture.controller.close();
    const originalEvent = readEvent(launched.directory, launched.taskId, kind);
    const finished = Promise.withResolvers<undefined>();

    const recovered = new WorkerController(fixture.directory, fixture.client, () => {
      finished.resolve(undefined);
    });

    afterTest(() => {
      recovered.close();
    });

    await recovered.resume('parent-id');

    expect(recovered.owns(launched.taskId)).toBe(true);

    if (kind === 'timeout') {
      await vi.advanceTimersByTimeAsync(7500);
      await finished.promise;
    }

    const stopped = await recovered
      .cancel(launched.taskId, 'parent-id')
      .catch((error: unknown) => error);

    expect(stopped).toMatchObject({ state: 'stopped' });
    expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(true);
    expect(recovered.status(launched.taskId, 'parent-id').state).toBe('stopped');
    expect(readEvent(launched.directory, launched.taskId, kind)).toEqual(originalEvent);
  },
);

it('refuses cancellation without saved ownership without exposing paths or changing records', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);
  fixture.controller.close();
  rmSync(join(launched.directory, 'owned.json'));
  const saved = readdirSync(launched.directory);
  const callsBefore = fixture.calls.length;
  const recovered = new WorkerController(fixture.directory, fixture.client);

  onTestFinished(() => {
    recovered.close();
  });

  const refusal = await recovered
    .cancel(launched.taskId, 'parent-id')
    .catch((error: unknown) => error);

  expect(refusal).toBeInstanceOf(Error);
  expect(String(refusal)).not.toContain(launched.directory);
  expect(readdirSync(launched.directory)).toEqual(saved);
  expect(fixture.calls).toHaveLength(callsBefore);
});

it('resumes the remaining workers when one saved task has no ownership record', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  const unowned = await fixture.controller.launch(fixture.input);
  const owned = await fixture.controller.launch(fixture.input);
  fixture.controller.close();
  rmSync(join(unowned.directory, 'owned.json'));
  const recovered = new WorkerController(fixture.directory, fixture.client);

  onTestFinished(() => {
    recovered.close();
  });

  await recovered.resume('parent-id');

  expect(recovered.owns(unowned.taskId)).toBe(false);
  expect(recovered.owns(owned.taskId)).toBe(true);
  expect(recovered.status(owned.taskId, 'parent-id').state).toBe('starting');
});

it('reattaches a healthy worker after a task with corrupt cleanup without changing corrupt records', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  const corrupt = await fixture.controller.launch(fixture.input);
  const healthy = await fixture.controller.launch(fixture.input);
  fixture.controller.close();
  writeFileSync(join(corrupt.directory, 'cleanup.json'), '{');

  const snapshot = () =>
    readdirSync(corrupt.directory)
      .toSorted()
      .map((name) => [name, readFileSync(join(corrupt.directory, name))]);

  const before = snapshot();

  vi.spyOn(records, 'readTasks').mockReturnValueOnce([
    { directory: corrupt.directory, task: readTask(corrupt.directory) },
    { directory: healthy.directory, task: readTask(healthy.directory) },
  ]);

  const recovered = new WorkerController(fixture.directory, fixture.client);

  onTestFinished(() => {
    recovered.close();
  });

  await expect(recovered.resume(fixture.input.parentSessionId)).resolves.toBeUndefined();

  expect(recovered.owns(healthy.taskId)).toBe(true);
  expect(recovered.owns(corrupt.taskId)).toBe(false);
  expect(snapshot()).toEqual(before);
});

it('confirms an exited worker once after the saved deadline has expired', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);
  fixture.controller.close();
  fixture.fake.state.stopped = true;

  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
  });

  await vi.advanceTimersByTimeAsync(20_000);
  const callsBefore = fixture.calls.length;
  const recovered = new WorkerController(fixture.directory, fixture.client);

  onTestFinished(() => {
    recovered.close();
  });

  await recovered.resume('parent-id');

  expect(fixture.calls).toHaveLength(callsBefore);
  const stopped = await recovered.cancel(launched.taskId, 'parent-id');

  expect(stopped.state).toBe('stopped');
  expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(true);
  expect(fixture.fake.layout.panes.map((pane) => pane.pane_id)).toEqual(['parent']);
  const cleanupCalls = fixture.calls.length;
  const cleanup = readEvent(launched.directory, launched.taskId, 'cleanup');
  await recovered.cancel(launched.taskId, 'parent-id');

  expect(fixture.calls).toHaveLength(cleanupCalls);
  expect(readEvent(launched.directory, launched.taskId, 'cleanup')).toEqual(cleanup);
});

it.each(['before resume', 'during inspection'])(
  'stops a saved running worker when its work budget expires %s',
  async (expiry) => {
    vi.useFakeTimers();
    vi.stubEnv('TAU_SUBAGENT_CAP', '1');

    afterTest(() => {
      vi.unstubAllEnvs();
    });

    const fixture = setup(afterTest);

    const launched = await fixture.controller.launch(fixture.input);
    fixture.controller.close();
    const elapsed = expiry === 'before resume' ? 20_000 : 7000;
    await vi.advanceTimersByTimeAsync(elapsed);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let paused = false;
    const notifications: WorkerNotice[] = [];

    const recovered = new WorkerController(
      fixture.directory,
      async (argumentsList, budget, signal) => {
        const agentGet = argumentsList[0] === 'agent' && argumentsList[1] === 'get';

        if (expiry === 'during inspection' && agentGet && !paused) {
          paused = true;
          entered.resolve(undefined);
          await release.promise;
        }

        return fixture.client(argumentsList, budget, signal);
      },
      (notice) => notifications.push(notice),
    );

    afterTest(() => {
      recovered.close();
    });

    const resuming = recovered.resume('parent-id');

    if (expiry === 'during inspection') {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1000);
      release.resolve(undefined);
    }

    await resuming;

    expect(fixture.fake.calls).toContainEqual(['pane', 'close', 'worker-1']);

    expect(readEvent(launched.directory, launched.taskId, 'timeout')).toBeDefined();
    expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(true);

    expect(recovered.status(launched.taskId, 'parent-id')).toMatchObject({
      state: 'stopped',
      outcome: 'timeout',
    });

    expect(fixture.fake.layout.panes.map((pane) => pane.pane_id)).toEqual(['parent']);
    expect(notifications).toHaveLength(1);
    fixture.fake.state.stopped = false;
    const next = await recovered.launch(fixture.input);

    expect(next.state).toBe('starting');
    expect(recovered.owns(next.taskId)).toBe(true);
  },
);

it('resumes polling with the remaining wall-clock deadline', async ({ onTestFinished }) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);

  const launched = await fixture.controller.launch(fixture.input);
  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');
  fixture.controller.close();
  const task = readTask(launched.directory);

  writeFileSync(
    join(launched.directory, 'task.json'),
    JSON.stringify({ ...task, monotonicDeadline: 1 }),
  );

  await vi.advanceTimersByTimeAsync(2000);
  const recovered = new WorkerController(fixture.directory, fixture.client);

  onTestFinished(() => {
    recovered.close();
  });

  await recovered.resume('parent-id');
  await vi.advanceTimersByTimeAsync(5499);

  expect(recovered.status(launched.taskId, 'parent-id').state).toBe('running');
  await vi.advanceTimersByTimeAsync(1);

  await vi.waitFor(() => {
    expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(true);
  });

  expect(recovered.status(launched.taskId, 'parent-id')).toMatchObject({
    state: 'stopped',
    outcome: 'timeout',
    deadline: task.deadline,
  });

  expect(readTask(launched.directory).monotonicDeadline).toBe(1);
});

it.each(['changed session', 'absent process'])(
  'does not reattach %s but attempts saved cleanup',
  async (failure) => {
    vi.useFakeTimers();
    const fixture = setup(afterTest);
    const launched = await fixture.controller.launch(fixture.input);
    recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');
    fixture.fake.state.session = 'different-session';

    if (failure === 'absent process') {
      fixture.fake.state.stopped = true;

      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
      });
    }

    const saved = readdirSync(launched.directory);
    const recovered = new WorkerController(fixture.directory, fixture.client);

    afterTest(() => {
      recovered.close();
    });

    await recovered.resume('parent-id');

    expect(recovered.owns(launched.taskId)).toBe(false);
    expect(readdirSync(launched.directory)).toEqual(saved);

    expect(recovered.status(launched.taskId, 'parent-id')).toMatchObject({
      state: 'notOwned',
      recovery: { paneId: 'worker-1' },
    });

    const stopped = await recovered.cancel(launched.taskId, 'parent-id');

    expect(stopped.state).toBe(failure === 'absent process' ? 'stopped' : 'cleanupUnconfirmed');

    expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(
      failure === 'absent process',
    );

    expect(fixture.calls.filter((call) => call[1] === 'close')).toEqual([]);

    expect(fixture.fake.layout.panes.map((pane) => pane.pane_id)).toEqual(
      failure === 'absent process' ? ['parent'] : ['parent', 'worker-1'],
    );
  },
);

it.each([true, false])('does not reattach work with cleanup stopped %s', async (stopped) => {
  vi.useFakeTimers();
  const fixture = setup(afterTest);
  const launched = await fixture.controller.launch(fixture.input);
  recordEvent(launched.directory, launched.taskId, 'cleanup', { detail: 'Handled.', stopped });

  const saved = readdirSync(launched.directory);
  const callsBefore = fixture.calls.length;
  const recovered = new WorkerController(fixture.directory, fixture.client);

  afterTest(() => {
    recovered.close();
  });

  await recovered.resume('parent-id');

  expect(recovered.owns(launched.taskId)).toBe(false);
  expect(fixture.calls).toHaveLength(callsBefore);
  expect(readdirSync(launched.directory)).toEqual(saved);
});

it('does not reattach or cancel work from another parent session', async ({ onTestFinished }) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);
  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');
  const callsBefore = fixture.calls.length;
  const recordsBefore = readdirSync(launched.directory);
  const recovered = new WorkerController(fixture.directory, fixture.client);

  onTestFinished(() => {
    recovered.close();
  });

  await recovered.resume('another-parent');

  expect(recovered.owns(launched.taskId)).toBe(false);

  await expect(recovered.cancel(launched.taskId, 'another-parent')).rejects.toThrow(
    'another parent',
  );

  expect(fixture.calls).toHaveLength(callsBefore);
  expect(readdirSync(launched.directory)).toEqual(recordsBefore);
});
