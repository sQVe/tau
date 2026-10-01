import {
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it, vi, onTestFinished as afterTest } from 'vitest';

import { writeWorkerActivity } from '../activity.js';
import * as cancellationModule from '../cancellation.js';
import { herdrFake } from '../fixtures/herdrFake.js';
import { fixtureLoadout } from '../fixtures/loadout.js';
import { placementFixture } from '../fixtures/placement.js';
import { searchHistory } from '../history.js';
import * as loadoutModule from '../loadout.js';
import * as names from '../names.js';
import type { WorkerNotice } from '../presentation.js';
import * as questions from '../questionRecords.js';
import { acceptReport, readEvent, readTask, recordEvent } from '../records.js';
import * as records from '../records.js';
import * as terminalModule from '../terminal.js';
import { taskVersion } from '../types.js';
import type { Loadout } from '../types.js';
import { WorkerController } from './controller.js';
import { RequestNotSentError, workerArguments } from './inspect.js';
import type { HerdrClient } from './inspect.js';
import type { WorkerPackageManager } from './packageInstall.js';
import { EvidenceUnavailableError, taskStatus } from './record.js';

vi.mock(import('node:fs'), { spy: true });

const originalRunClient = cancellationModule.runClient;

const captureError = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error('Expected the action to throw.');
};

const setup = (
  onTestFinished: (callback: () => void) => void,
  readyDelay = 0,
  intercept?: HerdrClient,
  packageManager?: (loadout: Loadout) => WorkerPackageManager,
) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-controller-'));

  onTestFinished(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  writeFileSync(
    join(directory, 'parent.jsonl'),
    `${JSON.stringify({ type: 'session', version: 3, id: 'parent-id', cwd: directory })}\n`,
  );

  const fake = herdrFake();

  vi.spyOn(cancellationModule, 'runClient').mockImplementation(
    (executable, argumentsList, budget, options) => {
      if (executable === 'ps' && ['100', '101', '102'].includes(argumentsList[1] ?? '')) {
        return Promise.resolve('fixture shell start');
      }

      return originalRunClient(executable, argumentsList, budget, options);
    },
  );

  // The fake worker is this test process, which is gone once its pane closes.
  const originalProcessAbsent = cancellationModule.processAbsent;

  vi.spyOn(cancellationModule, 'processAbsent').mockImplementation((processId) =>
    processId === fake.state.process ? fake.state.stopped : originalProcessAbsent(processId),
  );

  const calls: string[][] = [];
  let startAttempted = false;

  const client: HerdrClient = async (argumentsList, budget, signal) => {
    calls.push(argumentsList);

    if (argumentsList[0] === 'layout' || argumentsList[1] === 'start') {
      startAttempted = true;
    }

    if (argumentsList[1] === 'process-info' && !startAttempted) {
      return fake.client(argumentsList, budget, signal);
    }

    if (intercept) {
      const response = await intercept(argumentsList, budget, signal);

      if (response) {
        return response;
      }
    }

    // Placement starts a Pi worker as its pane's own process.
    if (argumentsList[0] === 'layout') {
      const root = (
        JSON.parse(argumentsList[2] ?? '') as {
          root: { command: string[]; env: Record<string, string> };
        }
      ).root;

      const recordDirectory = root.env.TAU_WORKER_RECORD ?? '';
      fake.state.session = root.command[root.command.indexOf('--session') + 1] ?? '';
      const task = readTask(recordDirectory);

      const ready = () => {
        recordEvent(recordDirectory, task.taskId, 'ready', {
          detail: 'Ready.',
          processId: process.pid,
        });
      };

      if (readyDelay > 0) {
        setTimeout(ready, readyDelay);
      } else if (readyDelay === 0) {
        ready();
      }
    }

    return fake.client(argumentsList, budget, signal);
  };

  const notifications: WorkerNotice[] = [];

  const controller = new WorkerController(
    directory,
    client,
    (notice) => notifications.push(notice),
    packageManager,
  );

  onTestFinished(() => {
    controller.close();
  });

  const input = {
    task: 'Edit fixture and test it.',
    loadout: fixtureLoadout(directory),
    timeout: 10_000,
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent-id',
    parentPane: 'parent',
  };

  return { directory, controller, client, fake, calls, notifications, input };
};

it('reattaches accepted work and cancels it without replacing saved records', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);

  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (fixture.fake.state.stopped) {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    }

    return true;
  });

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

it('saves a launched Pi task in the current record format', async ({ onTestFinished }) => {
  const fixture = setup(onTestFinished);

  const launched = await fixture.controller.launch(fixture.input);

  expect(JSON.parse(readFileSync(join(launched.directory, 'task.json'), 'utf8'))).toMatchObject({
    version: 7,
  });
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

  expect(launched).toBeInstanceOf(Error);
  expect(String(launched)).toContain('capacity full');
  expect(readdirSync(fixture.directory)).toEqual(recordsBefore);
  expect(fixture.calls.filter((call) => call[0] === 'layout')).toHaveLength(startsBefore);
  expect(recovered.owns(saved.taskId)).toBe(true);
});

it('stops a saved worker while its resume inspection is pending', async ({ onTestFinished }) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);

  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (fixture.fake.state.stopped) {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    }

    return true;
  });

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

  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (fixture.fake.state.stopped) {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    }

    return true;
  });

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

    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (fixture.fake.state.stopped) {
        throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
      }

      return true;
    });

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

    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (fixture.fake.state.stopped) {
        throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
      }

      return true;
    });

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

  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (fixture.fake.state.stopped) {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    }

    return true;
  });

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

const dispatchRecordedForWorker = (calls: string[][]): boolean => {
  const launch = calls.find((call) => call[0] === 'layout')?.[2];

  const recordDirectory =
    launch === undefined
      ? undefined
      : (JSON.parse(launch) as { root: { env: Record<string, string> } }).root.env
          .TAU_WORKER_RECORD;

  return recordDirectory !== undefined && readdirSync(recordDirectory).includes('dispatch.json');
};

it('skips unpublished preparation debris while published attempts remain exclusive', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_SUBAGENT_CAP', '1');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const fixture = setup(onTestFinished);

  writeFileSync(
    fixture.input.parentSession,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: fixture.input.parentSessionId,
      cwd: fixture.directory,
    }) + '\n',
  );

  const originalPublish = records.publishRecord;

  const preparation = vi
    .spyOn(records, 'publishRecord')
    .mockImplementation((directory, name, value) => {
      vi.mocked(fsyncSync).mockImplementationOnce(() => {
        throw new Error('Initial task file sync failed.');
      });

      preparation.mockRestore();
      originalPublish(directory, name, value);
    });

  await expect(fixture.controller.launch(fixture.input)).rejects.toThrow('Task preparation');

  expect(fixture.calls.some((call) => ['start', 'apply', 'create'].includes(call[1] ?? ''))).toBe(
    false,
  );

  const abandoned = readdirSync(fixture.directory, { withFileTypes: true }).find((entry) =>
    entry.isDirectory(),
  );

  if (!abandoned) {
    throw new Error('Missing preparation evidence.');
  }

  const abandonedDirectory = join(fixture.directory, abandoned.name);
  const receiptFiles = readdirSync(abandonedDirectory);
  expect(receiptFiles).toHaveLength(1);
  expect(receiptFiles[0]).toMatch(/^\.receipt-/);
  const receipt = readFileSync(join(abandonedDirectory, receiptFiles[0] ?? ''));

  const launched = await fixture.controller.launch(fixture.input);
  expect(launched.state).toBe('starting');
  expect(launched).not.toHaveProperty('outcome');

  const current = {
    file: fixture.input.parentSession,
    id: fixture.input.parentSessionId,
    sessionDirectory: fixture.directory,
  };

  const history = await searchHistory(fixture.directory, current);
  expect(history.candidates.some((candidate) => candidate.taskId === launched.taskId)).toBe(true);
  expect(history.diagnostics.join(' ')).toContain(abandoned.name);
  expect(readFileSync(join(abandonedDirectory, receiptFiles[0] ?? ''))).toEqual(receipt);

  records.acceptReport(launched.directory, launched.taskId, {
    taskId: launched.taskId,
    outcome: 'success',
    summary: 'Finished.',
    evidence: [],
  });

  recordEvent(launched.directory, launched.taskId, 'cleanup', {
    detail: 'Parent confirmed.',
    stopped: true,
  });

  fixture.controller.close();
  const controller = new WorkerController(fixture.directory, fixture.client);

  onTestFinished(() => {
    controller.close();
  });

  const attemptDirectory = join(fixture.directory, 'published-attempt');
  mkdirSync(attemptDirectory);

  const attempt = records.validateTask({
    ...readTask(launched.directory),
    taskId: 'published-attempt',
    predecessorTaskId: launched.taskId,
  });

  records.publish(attemptDirectory, 'task.json', attempt);
  recordEvent(attemptDirectory, attempt.taskId, 'accepted', 'Accepted attempt.');

  const input = {
    task: 'Follow up.',
    sourceTaskId: launched.taskId,
    timeout: 10000,
    parentSession: current.file,
    parentSessionId: current.id,
    parentPane: 'parent',
  };

  const context = { cwd: fixture.directory, isProjectTrusted: () => true } as Parameters<
    WorkerController['followUp']
  >[1];

  vi.spyOn(loadoutModule, 'validateSavedLoadout').mockImplementation(
    (value) => value as ReturnType<typeof readTask>['loadout'],
  );

  await expect(controller.followUp(input, context)).rejects.toThrow('published-attempt');
  expect(readdirSync(abandonedDirectory)).toEqual(receiptFiles);
});

const savedFiles = (directory: string) => {
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true });

  return entries.map((entry) => {
    const path = join(entry.parentPath, entry.name);
    const bytes = entry.isFile() ? readFileSync(path) : undefined;

    return { path, bytes };
  });
};

const completed = async (
  intercept?: HerdrClient,
  packages?: { manager: (loadout: Loadout) => WorkerPackageManager; sources: string[] },
) => {
  const fixture = setup(afterTest, 0, intercept, packages?.manager);

  fixture.input.loadout = { ...fixture.input.loadout, packages: packages?.sources ?? [] };

  writeFileSync(
    fixture.input.parentSession,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: fixture.input.parentSessionId,
      cwd: fixture.directory,
    }) + '\n',
  );

  const status = await fixture.controller.launch(fixture.input);

  records.acceptReport(status.directory, status.taskId, {
    taskId: status.taskId,
    outcome: 'success',
    summary: 'Finished.',
    evidence: ['Checked.'],
  });

  recordEvent(status.directory, status.taskId, 'settled', {
    detail: 'Worker settled.',
    stopped: true,
  });

  recordEvent(status.directory, status.taskId, 'cleanup', {
    detail: 'Parent confirmed exit.',
    stopped: true,
  });

  fixture.controller.close();

  const controller = new WorkerController(
    fixture.directory,
    fixture.client,
    undefined,
    packages?.manager,
  );

  afterTest(() => {
    controller.close();
  });

  const validation = vi
    .spyOn(loadoutModule, 'validateSavedLoadout')
    .mockImplementation((value) => value as ReturnType<typeof readTask>['loadout']);

  const context = { cwd: fixture.directory, isProjectTrusted: () => true } as Parameters<
    typeof loadoutModule.validateSavedLoadout
  >[1];

  const input = {
    task: 'Follow up within saved settings.',
    sourceTaskId: status.taskId,
    timeout: 12000,
    parentSession: fixture.input.parentSession,
    parentSessionId: fixture.input.parentSessionId,
    parentPane: fixture.input.parentPane,
  };

  return {
    ...fixture,
    controller,
    validation,
    context,
    input,
    source: readTask(status.directory),
    sourceDirectory: status.directory,
  };
};

it.each(['pending', 'uncertain cleanup', 'dispatch', 'accepted', 'report'] as const)(
  'refuses follow-up without writes when a successor has %s evidence',
  async (evidence) => {
    const fixture = await completed();
    const directory = join(fixture.directory, 'successor');
    mkdirSync(directory);

    records.publish(directory, 'task.json', {
      ...fixture.source,
      taskId: 'successor',
      predecessorTaskId: fixture.source.taskId,
    });

    if (evidence !== 'pending') {
      recordEvent(directory, 'successor', 'cleanup', {
        detail: 'Cleanup result.',
        stopped: evidence !== 'uncertain cleanup',
      });
    }

    if (evidence === 'dispatch') {
      records.publish(directory, 'dispatch.json', { taskId: 'successor' });
    }

    if (evidence === 'accepted') {
      recordEvent(directory, 'successor', 'accepted', 'Accepted.');
    }

    if (evidence === 'report') {
      acceptReport(directory, 'successor', {
        taskId: 'successor',
        outcome: 'success',
        summary: 'Done.',
        evidence: [],
      });
    }

    const saved = savedFiles(fixture.directory);
    fixture.calls.length = 0;

    await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
      'successor',
    );

    expect(savedFiles(fixture.directory)).toEqual(saved);
    expect(fixture.calls).toEqual([['agent', 'list']]);
  },
);

it('admits follow-up with retired records and an unpublished directory', async () => {
  const fixture = await completed();

  const retiredRecords = [
    { ...fixture.source, taskId: 'retired-tree', tree: {} },
    { ...fixture.source, taskId: 'retired-owner', ownerId: 'old-controller' },
    {
      ...fixture.source,
      taskId: 'retired-fingerprint',
      loadout: { ...fixture.source.loadout, modelFingerprint: '0'.repeat(64) },
    },
  ];

  for (const record of retiredRecords) {
    const directory = join(fixture.directory, record.taskId);
    mkdirSync(directory);
    records.publish(directory, 'task.json', record);
  }

  const unpublished = join(fixture.directory, 'unpublished');
  mkdirSync(unpublished);
  const saved = savedFiles(fixture.directory);
  const result = fixture.controller.followUp(fixture.input, fixture.context);

  await expect(result).resolves.toMatchObject({
    state: 'starting',
    predecessorTaskId: fixture.source.taskId,
  });

  expect(savedFiles(fixture.directory)).toEqual(expect.arrayContaining(saved));
  expect(readdirSync(unpublished)).toEqual([]);
});

it('reports unreadable successor records and refuses follow-up without writes', async () => {
  const fixture = await completed();
  const directory = join(fixture.directory, 'unreadable');
  mkdirSync(directory);
  writeFileSync(join(directory, 'task.json'), '{');
  const saved = savedFiles(fixture.directory);
  fixture.calls.length = 0;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'unreadable',
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
  expect(fixture.calls).toEqual([['agent', 'list']]);
});

const newerTauRecord = (source: ReturnType<typeof readTask>, predecessorTaskId: string) => ({
  ...source,
  taskId: 'newer',
  name: 'critic-ab',
  predecessorTaskId,
  version: taskVersion + 1,
  loadout: { ...source.loadout, profile: 'critic' },
  futureField: 'written by a newer Tau',
});

it('lists a newer Tau record as unreadable and still follows up an unrelated task', async () => {
  const fixture = await completed();
  const directory = join(fixture.directory, 'newer');
  mkdirSync(directory);
  records.publish(directory, 'task.json', newerTauRecord(fixture.source, 'unrelated'));

  const history = await searchHistory(fixture.directory, {
    file: fixture.input.parentSession,
    id: fixture.input.parentSessionId,
    sessionDirectory: fixture.directory,
  });

  expect(history.diagnostics).toContain(
    'Skipped task newer saved by a newer Tau; restart this session to read it.',
  );

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).resolves.toMatchObject({
    state: 'starting',
    predecessorTaskId: fixture.source.taskId,
  });
});

it('refuses follow-up without writes when a newer Tau record names the same predecessor', async () => {
  const fixture = await completed();
  const directory = join(fixture.directory, 'newer');
  mkdirSync(directory);
  records.publish(directory, 'task.json', newerTauRecord(fixture.source, fixture.source.taskId));
  const saved = savedFiles(fixture.directory);
  fixture.calls.length = 0;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'Cannot verify saved follow-up attempts',
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
  expect(fixture.calls).toEqual([['agent', 'list']]);
});

it('refuses follow-up without writes when a current task that looks retired names the same predecessor', async () => {
  const fixture = await completed();
  const directory = join(fixture.directory, 'malformed');
  mkdirSync(directory);

  records.publish(directory, 'task.json', {
    ...fixture.source,
    taskId: 'malformed',
    predecessorTaskId: fixture.source.taskId,
    parentTaskId: 'ancestor',
  });

  const saved = savedFiles(fixture.directory);
  fixture.calls.length = 0;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'Cannot verify saved follow-up attempts',
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
  expect(fixture.calls).toEqual([['agent', 'list']]);
});

const saveNonPiTask = (root: string): void => {
  const directory = join(root, 'previous-generic');
  mkdirSync(directory);

  for (const [name, fixture] of [
    ['task.json', 'taskRecords/previous-generic.json'],
    ['submission-assignment-intent.json', 'submissionRecords/submission-assignment-intent.json'],
    [
      'submission-assignment-observation.json',
      'submissionRecords/submission-assignment-observation.json',
    ],
  ] as const) {
    const source = new URL(`../fixtures/${fixture}`, import.meta.url);

    writeFileSync(join(directory, name), readFileSync(source, 'utf8'));
  }
};

it('refuses a saved non-Pi task by name and still serves Pi tasks', async () => {
  const fixture = await completed();
  saveNonPiTask(fixture.directory);
  const unsupported = 'Tau no longer supports non-Pi workers.';
  const saved = savedFiles(fixture.directory);

  const history = await searchHistory(fixture.directory, {
    file: fixture.input.parentSession,
    id: fixture.input.parentSessionId,
    sessionDirectory: fixture.directory,
  });

  expect(history.diagnostics).toContain(
    `Skipped task previous-generic run by a non-Pi worker; ${unsupported}`,
  );

  const status = () => fixture.controller.status('previous-generic', 'parent-one');

  expect(status).toThrow(EvidenceUnavailableError);
  expect(status).toThrow(unsupported);

  await expect(fixture.controller.cancel('previous-generic', 'parent-one')).rejects.toThrow(
    unsupported,
  );

  await expect(
    fixture.controller.followUp(
      { ...fixture.input, sourceTaskId: 'previous-generic' },
      fixture.context,
    ),
  ).rejects.toThrow(unsupported);

  expect(savedFiles(fixture.directory)).toEqual(saved);

  expect(fixture.controller.widgetRows('parent-id').map(({ taskId }) => taskId)).toEqual([
    fixture.source.taskId,
  ]);

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).resolves.toMatchObject({
    state: 'starting',
    predecessorTaskId: fixture.source.taskId,
  });
});

it('refuses follow-up of a malformed source task ID without writes', async () => {
  const fixture = await completed();
  const saved = savedFiles(fixture.directory);
  fixture.calls.length = 0;

  await expect(
    fixture.controller.followUp({ ...fixture.input, sourceTaskId: '../escape' }, fixture.context),
  ).rejects.toThrow('Follow-up requires an exact saved task ID.');

  expect(savedFiles(fixture.directory)).toEqual(saved);
  expect(fixture.calls).toEqual([]);
});

it('refuses another follow-up when cleanup cannot verify the worker', async () => {
  let following = false;
  let absenceChecks = 0;

  const fixture = await completed(async (argumentsList) => {
    if (!following) {
      return '';
    }

    if (argumentsList[0] === 'agent' && argumentsList[1] === 'get') {
      absenceChecks += 1;
    }

    if (absenceChecks > 0 && argumentsList[1] === 'process-info') {
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: argumentsList[3],
            shell_pid: 100,
            foreground_process_group_id: process.pid,
            foreground_processes: [{ pid: process.pid, argv: ['unrelated-job'] }],
          },
        },
      });
    }

    return '';
  });

  following = true;

  const failed = await fixture.controller.followUp(fixture.input, fixture.context);

  expect(failed.state).toBe('cleanupUnconfirmed');
  expect(readEvent(failed.directory, failed.taskId, 'cleanup')?.stopped).toBe(false);
  expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBe(failed.taskId);
  expect(fixture.calls.some((call) => call[1] === 'close')).toBe(false);
  const saved = savedFiles(fixture.directory);

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    failed.taskId,
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
});

it('allows follow-up retry after the worker exits before readiness', async () => {
  let exiting = false;

  const fixture = await completed(async (argumentsList) => {
    // The worker exits once herdr first sees it.
    if (exiting && argumentsList[0] === 'agent' && argumentsList[1] === 'get') {
      fixture.fake.state.stopped = true;
    }

    return '';
  });

  exiting = true;
  const failed = await fixture.controller.followUp(fixture.input, fixture.context);

  expect(failed.state).toBe('stopped');
  expect(failed.failure).toContain('Worker exited before readiness');
  expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBeUndefined();
  expect(readdirSync(failed.directory)).not.toContain('dispatch.json');
  expect(readEvent(failed.directory, failed.taskId, 'accepted')).toBeUndefined();
  expect(records.readReport(failed.directory, failed.taskId)).toBeUndefined();
  expect(readEvent(failed.directory, failed.taskId, 'cleanup')?.stopped).toBe(true);
  exiting = false;
  fixture.fake.state.stopped = false;
  const retried = await fixture.controller.followUp(fixture.input, fixture.context);

  expect(retried.state).toBe('starting');
  expect(retried.taskId).not.toBe(failed.taskId);
  expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBe(retried.taskId);
});

it('follows up a completed native task with new identity and unchanged saved evidence', async () => {
  const fixture = await completed();
  const taskBytes = readFileSync(join(fixture.sourceDirectory, 'task.json'));
  const reportBytes = readFileSync(join(fixture.sourceDirectory, 'report.json'));
  const nativeBytes = readFileSync(fixture.source.nativeSessionFile);
  expect(fixture.controller).toHaveProperty('followUp');
  const next = await fixture.controller.followUp(fixture.input, fixture.context);
  const task = readTask(next.directory);

  expect(task.taskId).not.toBe(fixture.source.taskId);
  expect(task.deadline).not.toBe(fixture.source.deadline);

  expect(task).toMatchObject({
    predecessorTaskId: fixture.source.taskId,
    nativeSessionId: fixture.source.nativeSessionId,
    nativeSessionFile: fixture.source.nativeSessionFile,
    loadout: fixture.source.loadout,
  });

  expect(task.name).not.toBe(fixture.source.name);

  expect(next).toMatchObject({
    predecessorTaskId: fixture.source.taskId,
    predecessorName: fixture.source.name,
  });

  expect(taskStatus(next.directory)).toMatchObject({
    predecessorTaskId: fixture.source.taskId,
    predecessorName: fixture.source.name,
  });

  expect(
    fixture.controller.status(fixture.source.taskId, fixture.input.parentSessionId),
  ).toMatchObject({
    successorTaskId: next.taskId,
  });

  const history = await searchHistory(fixture.directory, {
    file: fixture.input.parentSession,
    id: fixture.input.parentSessionId,
    sessionDirectory: fixture.directory,
  });

  expect(
    history.candidates.find((candidate) => candidate.taskId === fixture.source.taskId),
  ).toMatchObject({
    successorTaskId: next.taskId,
  });

  expect(readFileSync(join(fixture.sourceDirectory, 'task.json'))).toEqual(taskBytes);
  expect(readFileSync(join(fixture.sourceDirectory, 'report.json'))).toEqual(reportBytes);
  expect(readFileSync(fixture.source.nativeSessionFile)).toEqual(nativeBytes);
  const saved = savedFiles(fixture.directory);

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    task.taskId,
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
});

it.each(['cleanup', 'uncertain cleanup', 'handover', 'missing native', 'out of tree'] as const)(
  'refuses native follow-up with %s',
  async (failure) => {
    const fixture = await completed();

    if (failure === 'cleanup' || failure === 'uncertain cleanup') {
      rmSync(join(fixture.sourceDirectory, 'cleanup.json'));

      if (failure === 'uncertain cleanup') {
        recordEvent(fixture.sourceDirectory, fixture.source.taskId, 'cleanup', {
          detail: 'Unknown stop.',
          stopped: false,
        });
      }
    } else if (failure === 'handover') {
      rmSync(join(fixture.sourceDirectory, 'report.json'));
    } else if (failure === 'missing native') {
      rmSync(fixture.source.nativeSessionFile);
    } else {
      fixture.input.parentSession = join(fixture.directory, 'unrelated.jsonl');
      fixture.input.parentSessionId = 'unrelated';

      writeFileSync(
        fixture.input.parentSession,
        JSON.stringify({ type: 'session', version: 3, id: 'unrelated', cwd: fixture.directory }) +
          '\n',
      );
    }

    const saved = savedFiles(fixture.directory);

    await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
      /cleanup|handover|native|tree/i,
    );

    expect(savedFiles(fixture.directory)).toEqual(saved);
  },
);

it('classifies follow-up readiness deadline expiry as timeout rather than caller cancellation', async () => {
  let following = false;
  const started = Promise.withResolvers<undefined>();

  const fixture = await completed(async (argumentsList, budget, signal) => {
    if (following && argumentsList[0] === 'layout') {
      started.resolve(undefined);

      return fixture.fake.client(argumentsList, budget, signal);
    }

    return '';
  });

  following = true;
  const validationDeadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(validationDeadline.signal);
  // Leave slow runners room to reach start; an early rejection fails here instead of hanging.
  vi.spyOn(cancellationModule, 'runClient').mockResolvedValue('fixture shell start');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const pending = fixture.controller.followUp(
    { ...fixture.input, timeout: 10_000 },
    fixture.context,
  );

  await Promise.race([started.promise, pending]);
  validationDeadline.abort(new DOMException('Validation deadline expired.', 'TimeoutError'));
  await vi.advanceTimersByTimeAsync(10_000);
  const status = await pending;

  expect(status.outcome).toBe('timeout');
  expect(records.readEvent(status.directory, status.taskId, 'cancelled')).toBeUndefined();
  expect(records.readEvent(status.directory, status.taskId, 'timeout')).toBeDefined();
  const task = readTask(status.directory);
  expect(task.deadline - task.createdAt).toBe(10_000);
});

it('allows only one competing follow-up and preserves lineage across parents and successive tasks', async () => {
  const fixture = await completed();
  const sibling = join(fixture.directory, 'sibling.jsonl');

  writeFileSync(
    sibling,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sibling',
      cwd: fixture.directory,
      parentSession: fixture.input.parentSession,
    }) + '\n',
  );

  fixture.calls.length = 0;
  const request = { ...fixture.input, parentSession: sibling, parentSessionId: 'sibling' };

  const attempts = await Promise.allSettled([
    fixture.controller.followUp(request, fixture.context),
    fixture.controller.followUp(request, fixture.context),
  ]);

  const successes = attempts.filter((entry) => entry.status === 'fulfilled');
  expect(successes).toHaveLength(1);
  const next = successes[0]?.value;

  if (!next) {
    throw new Error('Missing winner.');
  }

  expect(fixture.calls.filter((call) => call[0] === 'layout')).toHaveLength(1);
  expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBe(next.taskId);

  await expect(
    fixture.controller.followUp({ ...request, sourceTaskId: next.taskId }, fixture.context),
  ).rejects.toThrow('handover');

  records.acceptReport(next.directory, next.taskId, {
    taskId: next.taskId,
    outcome: 'success',
    summary: 'Second done.',
    evidence: [],
  });

  recordEvent(next.directory, next.taskId, 'cleanup', {
    detail: 'Parent confirmed.',
    stopped: true,
  });

  fixture.controller.close();
  const latestController = new WorkerController(fixture.directory, fixture.client);

  afterTest(() => {
    latestController.close();
  });

  const latest = await latestController.followUp(
    { ...fixture.input, sourceTaskId: next.taskId },
    fixture.context,
  );

  const history = await searchHistory(
    fixture.directory,
    { file: sibling, id: 'sibling', sessionDirectory: fixture.directory },
    fixture.source.nativeSessionId,
  );

  expect(history.outcome).toBe('clarification');

  expect(history.candidates.map((candidate) => candidate.taskId)).toEqual(
    expect.arrayContaining([fixture.source.taskId, next.taskId, latest.taskId]),
  );

  expect(history.candidates).toHaveLength(3);
  expect(readTask(latest.directory).nativeSessionFile).toBe(fixture.source.nativeSessionFile);

  expect(JSON.parse(readFileSync(fixture.source.nativeSessionFile, 'utf8'))).toMatchObject({
    parentSession: fixture.source.parentSession,
  });

  await expect(latestController.followUp(fixture.input, fixture.context)).rejects.toThrow(
    next.taskId,
  );

  await expect(
    latestController.followUp({ ...fixture.input, sourceTaskId: next.taskId }, fixture.context),
  ).rejects.toThrow(latest.taskId);
});

it.each(['cancelled', 'missing before launch'] as const)(
  'allows another follow-up after confirmed pre-start %s failure',
  async (failure) => {
    let following = false;
    const abort = new AbortController();
    let nativeFile = '';

    const fixture = await completed(async (argumentsList) => {
      if (following && argumentsList[1] === 'list' && failure === 'missing before launch') {
        rmSync(nativeFile);
      }

      if (following && argumentsList[1] === 'current' && failure === 'cancelled') {
        abort.abort(new Error('Caller cancelled.'));
      }

      return '';
    });

    nativeFile = fixture.source.nativeSessionFile;
    const nativeContents = readFileSync(nativeFile);
    following = true;

    const next = await fixture.controller.followUp(fixture.input, fixture.context, abort.signal);
    expect(next.outcome).toBe(failure === 'cancelled' ? 'cancelled' : 'failure');
    expect(next.state).toBe('stopped');
    expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBeUndefined();
    expect(records.readReport(next.directory, next.taskId)).toBeUndefined();
    following = false;

    const validationFailures: unknown[] = [];

    if (failure === 'missing before launch') {
      await fixture.controller.followUp(fixture.input, fixture.context).catch((error: unknown) => {
        validationFailures.push(error);
      });

      writeFileSync(nativeFile, nativeContents);
    }

    expect(validationFailures).toHaveLength(failure === 'missing before launch' ? 1 : 0);
    const retry = await fixture.controller.followUp(fixture.input, fixture.context);

    expect(retry.state).toBe('starting');
    expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBe(retry.taskId);
  },
);

it('refuses another follow-up when a lost launch response leaves an unconfirmed worker', async () => {
  let following = false;

  const fixture = await completed(async (argumentsList) => {
    if (following && argumentsList[0] === 'layout') {
      throw new Error('Response lost after launch');
    }

    return '';
  });

  following = true;

  const failed = await fixture.controller.followUp(fixture.input, fixture.context);
  const saved = savedFiles(fixture.directory);

  expect(failed.state).toBe('cleanupUnconfirmed');

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    failed.taskId,
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
  expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBe(failed.taskId);
});

it('refuses known live native writers and preserves validation time in the original follow-up budget', async () => {
  let live: unknown[] = [];

  const fixture = await completed(async (argumentsList) =>
    argumentsList[0] === 'agent' && argumentsList[1] === 'list'
      ? JSON.stringify({ result: { type: 'agent_list', agents: live } })
      : '',
  );

  live = [
    {
      pane_id: 'manual',
      name: 'manual-pi',
      agent_session: { kind: 'path', value: fixture.source.nativeSessionFile },
    },
  ];

  const saved = savedFiles(fixture.directory);
  fixture.calls.length = 0;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'already live',
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
  expect(fixture.calls).toEqual([['agent', 'list']]);
  live = [];
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);

  fixture.validation.mockImplementation((value) => {
    clock.mockReturnValue(20000);

    return value as ReturnType<typeof readTask>['loadout'];
  });

  fixture.calls.length = 0;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'budget expired',
  );

  expect(fixture.calls).toEqual([]);
  expect(savedFiles(fixture.directory)).toEqual(saved);
});

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

it.for(['reviewer', 'qa'])(
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

it('refuses full-cap native follow-up before publishing an attempt', async () => {
  const fixture = await completed();

  for (let index = 0; index < 4; index++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Fill the shared cap before attempting native follow-up.
    await fixture.controller.launch({ ...fixture.input, loadout: fixture.source.loadout });
  }

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'capacity full',
  );

  expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBeUndefined();

  expect(
    records
      .readTasks(fixture.directory)
      .some(({ task }) => task.predecessorTaskId === fixture.source.taskId),
  ).toBe(false);
});

it('dispatches the task before a stalled cosmetic pane rename can hold the launch', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const renameStarted = Promise.withResolvers<undefined>();
  let dispatchedWhenRenameStarted: boolean | undefined;

  const { controller, input, calls } = setup(
    onTestFinished,
    0,
    async (argumentsList, _budget, signal) => {
      if (argumentsList[1] === 'rename') {
        dispatchedWhenRenameStarted = dispatchRecordedForWorker(calls);
        renameStarted.resolve(undefined);

        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('rename aborted'));
            },
            { once: true },
          );
        });
      }

      return '';
    },
  );

  const launching = controller.launch(input);

  await renameStarted.promise;
  expect(dispatchedWhenRenameStarted).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  const launched = await launching;

  expect(launched.failure).toBeUndefined();
  expect(readdirSync(launched.directory)).toContain('dispatch.json');
  expect(calls.some((call) => call[1] === 'rename')).toBe(true);
  expect(calls.filter((call) => call[1] === 'rename')).toHaveLength(1);
});

it('bounds a stalled cosmetic terminal resolution by the same short deadline', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const resolutionStalled = Promise.withResolvers<undefined>();
  let started = false;
  let dispatchedWhenResolutionStalled: boolean | undefined;

  const { controller, input, calls } = setup(
    onTestFinished,
    0,
    async (argumentsList, _budget, signal) => {
      if (argumentsList[0] === 'layout') {
        started = true;
      }

      const cosmeticResolution =
        started && argumentsList[0] === 'pane' && argumentsList[1] === 'list';

      if (cosmeticResolution && dispatchRecordedForWorker(calls)) {
        dispatchedWhenResolutionStalled = dispatchRecordedForWorker(calls);
        resolutionStalled.resolve(undefined);

        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('terminal resolution aborted'));
            },
            { once: true },
          );
        });
      }

      return '';
    },
  );

  const launching = controller.launch(input);

  await resolutionStalled.promise;
  expect(dispatchedWhenResolutionStalled).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  const launched = await launching;

  expect(launched.failure).toBeUndefined();
  expect(readdirSync(launched.directory)).toContain('dispatch.json');
  expect(calls.some((call) => call[1] === 'rename')).toBe(false);
});

it('reports stopped without recovery once the parent confirmed the worker stopped', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const status = await controller.launch(input);

  recordEvent(status.directory, status.taskId, 'cleanup', {
    detail: 'Owned process stopped.',
    stopped: true,
  });

  controller.close();
  const recovered = new WorkerController(directory);

  onTestFinished(() => {
    recovered.close();
  });

  const recoveredStatus = recovered.status(status.taskId, input.parentSessionId);

  expect(recoveredStatus.state).toBe('stopped');
  expect(recoveredStatus.outcome).toBe('incomplete');
  expect(recoveredStatus).not.toHaveProperty('recovery');
});

it('tells active workers when the parent controller closes', async ({ onTestFinished }) => {
  const { controller, input } = setup(onTestFinished);
  const status = await controller.launch(input);

  controller.close();
  controller.close();

  expect(readEvent(status.directory, status.taskId, 'parentClosed')).toBeDefined();
  expect(() => controller.status(status.taskId, input.parentSessionId)).not.toThrow();
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

it('saves a clarification once without sending pane input', async ({ onTestFinished }) => {
  vi.useFakeTimers();

  const { controller, input, calls, notifications, directory } = setup(onTestFinished);

  const launched = await controller.launch(input);
  const task = readTask(launched.directory);
  recordEvent(launched.directory, task.taskId, 'accepted', 'Accepted.');

  const question = {
    version: 1,
    taskId: task.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  };

  questions.acceptQuestion(launched.directory, task.taskId, question);

  expect(controller).toHaveProperty('reply');
  expect(controller.status(task.taskId, 'parent-id').pendingQuestion).toEqual(question);

  const answer = {
    questionId: question.questionId,
    replyId: 'reply-one',
    reply: 'source.txt',
  };

  expect(() => controller.reply(task.taskId, 'wrong-parent', answer)).toThrow('another parent');

  expect(() =>
    controller.reply(task.taskId, 'parent-id', { ...answer, questionId: 'wrong' }),
  ).toThrow('pending question');

  const result = controller.reply(task.taskId, 'parent-id', answer);
  expect(result).toMatchObject({ replyAccepted: true });
  expect(result).toMatchObject({ workerAcknowledged: false });
  expect(result).toMatchObject({ name: task.name });
  controller.reply(task.taskId, 'parent-id', answer);
  expect(calls.some((call) => call[1] === 'prompt')).toBe(false);
  expect(records.readTask(launched.directory)).toEqual(task);

  expect(
    questions.readAcknowledgement(launched.directory, task.taskId, question.questionId),
  ).toBeUndefined();

  expect(notifications).toEqual([]);

  controller.close();
  const recovered = new WorkerController(directory);

  expect(recovered.status(task.taskId, 'parent-id').pendingQuestion).toEqual({
    ...question,
    replySaved: true,
  });

  expect(() => recovered.reply(task.taskId, 'parent-id', answer)).toThrow('active');
  recovered.close();
});

it('treats an unreadable acknowledgement as unacknowledged on a repeated reply', async ({
  onTestFinished,
}) => {
  const { controller, input } = setup(onTestFinished);

  const launched = await controller.launch(input);
  const task = readTask(launched.directory);
  recordEvent(launched.directory, task.taskId, 'accepted', 'Accepted.');

  questions.acceptQuestion(launched.directory, task.taskId, {
    version: 1,
    taskId: task.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });

  const answer = {
    questionId: 'question-one',
    replyId: 'reply-one',
    reply: 'source.txt',
  };

  controller.reply(task.taskId, 'parent-id', answer);
  writeFileSync(join(launched.directory, 'acknowledgement-question-one.json'), '{}');

  const repeated = controller.reply(task.taskId, 'parent-id', answer);

  expect(repeated).toMatchObject({ replyAccepted: true, workerAcknowledged: false });
});

it('refuses a conflicting reply to an answered question', async ({ onTestFinished }) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);
  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');

  questions.acceptQuestion(launched.directory, launched.taskId, {
    version: 1,
    taskId: launched.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });

  const answer = {
    questionId: 'question-one',
    replyId: 'reply-one',
    reply: 'source.txt',
  };

  controller.reply(launched.taskId, 'parent-id', answer);

  expect(controller.questionReceipt(launched.taskId, 'parent-id', 'question-one')).toMatchObject({
    reply: { replyId: 'reply-one' },
    acknowledgement: undefined,
  });

  expect(() =>
    controller.reply(launched.taskId, 'parent-id', { ...answer, reply: 'changed' }),
  ).toThrow('Conflicting');
});

it('saves a reply through a restarted parent that reattached the worker', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);
  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');

  questions.acceptQuestion(launched.directory, launched.taskId, {
    version: 1,
    taskId: launched.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });

  const recovered = new WorkerController(fixture.directory, fixture.client);

  onTestFinished(() => {
    recovered.close();
  });

  await recovered.resume('parent-id');

  expect(
    recovered.reply(launched.taskId, 'parent-id', {
      questionId: 'question-one',
      replyId: 'reply-one',
      reply: 'source.txt',
    }),
  ).toMatchObject({ replyAccepted: true, workerAcknowledged: false });

  expect(questions.readReply(launched.directory, launched.taskId, 'question-one')?.replyId).toBe(
    'reply-one',
  );

  expect(fixture.calls.some((call) => call[1] === 'prompt')).toBe(false);
});

it('notifies the parent once while waiting and refuses replies after the original deadline', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const { controller, input, notifications, calls } = setup(onTestFinished);
  const launched = await controller.launch(input);
  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');

  questions.acceptQuestion(launched.directory, launched.taskId, {
    version: 1,
    taskId: launched.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });

  await vi.advanceTimersByTimeAsync(500);
  expect(notifications).toHaveLength(1);

  expect(notifications[0]?.content).toMatchObject({
    state: 'awaitingReply',
    pendingQuestion: { questionId: 'question-one', question: 'Which file?' },
  });

  expect(notifications[0]?.question).toBe(true);
  expect(controller.status(launched.taskId, 'parent-id').deadline).toBe(launched.deadline);
  await vi.advanceTimersByTimeAsync(7500);

  expect(() =>
    controller.reply(launched.taskId, 'parent-id', {
      questionId: 'question-one',
      replyId: 'reply-one',
      reply: 'source.txt',
    }),
  ).toThrow('active');

  expect(calls.some((call) => call[1] === 'prompt')).toBe(false);
  expect(questions.readReply(launched.directory, launched.taskId, 'question-one')).toBeUndefined();
});

it('waits for Pi integration session identity before dispatch', async ({ onTestFinished }) => {
  let missingSessionResponses = 0;

  const fixture = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[0] === 'agent' && argumentsList[1] === 'get' && missingSessionResponses < 2) {
      missingSessionResponses += 1;

      return JSON.stringify({
        result: { agent: { pane_id: argumentsList[2], agent: 'pi', agent_session: null } },
      });
    }

    return '';
  });

  const launched = await fixture.controller.launch(fixture.input);
  expect(launched.state).toBe('starting');

  expect(readFileSync(join(launched.directory, 'dispatch.json'), 'utf8')).toContain(
    launched.taskId,
  );

  expect(missingSessionResponses).toBe(2);
});

it('refuses readiness when the worker process identity differs from the ready event', async ({
  onTestFinished,
}) => {
  let launched = false;

  const fixture = setup(onTestFinished, 0, async (argumentsList) => {
    launched ||= argumentsList[0] === 'layout';

    if (argumentsList[1] === 'process-info' && launched) {
      fixture.fake.state.process = process.pid === 101 ? 102 : 101;
    }

    return '';
  });

  const status = await fixture.controller.launch(fixture.input);

  expect(status.outcome).toBe('failure');
  expect(fixture.calls.some((call) => call[1] === 'prompt')).toBe(false);
});

it("names herdr's Pi integration when a started Pi worker reports no agent session", async ({
  onTestFinished,
}) => {
  const { controller, input, calls, notifications } = setup(
    onTestFinished,
    0,
    async (argumentsList) =>
      argumentsList[0] === 'agent' && argumentsList[1] === 'get'
        ? JSON.stringify({ result: { agent: { pane_id: 'owned-pane', agent: 'pi' } } })
        : '',
  );

  const launched = await controller.launch(input);

  expect(launched.outcome).toBe('failure');
  expect(launched.failure).toContain("herdr's Pi integration");
  expect(launched.failure).toContain('herdr integration install pi');
  expect(JSON.stringify(notifications)).toContain("herdr's Pi integration");
  expect(JSON.stringify(notifications)).toContain('herdr integration install pi');
  expect(calls.some((call) => call[1] === 'prompt')).toBe(false);
});

it.each(['confirmed', 'unconfirmed', 'confirmed with failing notices'] as const)(
  'keeps terminal ownership during %s cleanup and releases it afterward',
  async (outcome) => {
    const terminal = placementFixture(340, 100);
    const tokens = new Map<string, string>();
    const entered = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    let cleaning = false;
    let held = false;

    const harness = setup(afterTest, 0, async (argumentsList) => {
      if (cleaning && !held && argumentsList[1] === 'list') {
        held = true;
        entered.resolve(undefined);
        await resume.promise;

        if (outcome === 'unconfirmed') {
          throw new Error('Cleanup identity unavailable.');
        }
      }

      const paneId = argumentsList[argumentsList.indexOf('--pane') + 1]!;

      if (argumentsList[0] === 'layout') {
        const response = await terminal.client(argumentsList);

        const created = terminalModule.text(
          terminalModule.requireObject(
            terminalModule.requireObject(terminalModule.result(response).layout).root,
          ).pane_id,
        );

        const { command } = (JSON.parse(argumentsList[2]!) as { root: { command: string[] } }).root;

        const token = command[command.indexOf('--session') + 1]!;
        tokens.set(created, token);
        const task = readTask(dirname(token));

        recordEvent(dirname(token), task.taskId, 'ready', {
          detail: 'Ready.',
          processId: process.pid,
        });

        return response;
      }

      if (argumentsList[1] === 'close' && argumentsList[2] === 'worker-1') {
        fake.state.stopped = true;
      }

      if (argumentsList[1] === 'process-info') {
        return JSON.stringify({
          result: {
            process_info: {
              pane_id: paneId,
              shell_pid: process.pid,
              foreground_process_group_id: process.pid,
              foreground_processes: [{ pid: process.pid, argv: ['pi', tokens.get(paneId)] }],
            },
          },
        });
      }

      if (argumentsList[0] === 'agent' && argumentsList[1] === 'get') {
        return JSON.stringify({
          result: {
            agent: {
              pane_id: argumentsList[2],
              agent: 'pi',
              agent_session: { value: tokens.get(argumentsList[2]!) },
            },
          },
        });
      }

      if (argumentsList[0] === 'agent' && argumentsList[1] === 'list') {
        return '';
      }

      return terminal.client(argumentsList);
    });

    const { controller, input, fake, notifications } = harness;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = await controller.launch({ ...input, visibility: 'background' });
    expect(first.state).toBe('starting');

    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    });

    if (outcome === 'confirmed with failing notices') {
      vi.spyOn(notifications, 'push').mockImplementation(() => {
        throw new Error('Notice delivery failed.');
      });
    }

    cleaning = true;
    const cancellation = controller.cancel(first.taskId, input.parentSessionId);
    await entered.promise;
    let second: Awaited<ReturnType<typeof controller.launch>>;
    let settled: unknown;

    try {
      second = await controller.launch({ ...input, visibility: 'background' });
      expect(second.state).toBe('starting');
      // The cleaning worker still owns its tab, so the next worker joins it.
      expect(terminal.labels.get('background-1')).toBe(`${first.name}, ${second.name}`);
    } finally {
      resume.resolve(undefined);

      settled = await cancellation.then(
        () => undefined,
        (error: unknown) => error,
      );
    }

    expect(settled).toEqual(
      outcome === 'confirmed with failing notices'
        ? new Error('Notice delivery failed.')
        : undefined,
    );

    // Only a confirmed stop takes the worker's name out of its tab label.
    expect(terminal.labels.get('background-1')).toBe(
      outcome === 'unconfirmed' ? `${first.name}, ${second.name}` : second.name,
    );

    expect(terminal.panes.some((pane) => pane.pane_id === 'worker-1')).toBe(
      outcome === 'unconfirmed',
    );
  },
);

it('chooses a down split for a narrow tall parent without changing focus', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'current') {
      return JSON.stringify({
        result: {
          pane: {
            pane_id: 'parent',
            terminal_id: 'parent-terminal',
            workspace_id: 'workspace',
            tab_id: 'tab',
          },
        },
      });
    }

    if (argumentsList[0] === 'pane' && argumentsList[1] === 'list') {
      return JSON.stringify({
        result: {
          panes: [
            {
              pane_id: 'parent',
              terminal_id: 'parent-terminal',
              workspace_id: 'workspace',
              tab_id: 'tab',
            },
            {
              pane_id: 'worker-1',
              terminal_id: 'terminal-1',
              workspace_id: 'workspace',
              tab_id: 'tab',
            },
          ],
        },
      });
    }

    if (argumentsList[1] === 'layout') {
      return JSON.stringify({
        result: {
          layout: {
            workspace_id: 'workspace',
            tab_id: 'tab',
            zoomed: false,
            area: { width: 100, height: 90 },
            panes: [{ pane_id: 'parent', rect: { width: 100, height: 90 } }],
          },
        },
      });
    }

    return '';
  });

  const launched = await controller.launch(input);

  expect(launched.failure).toBeUndefined();

  expect(calls.find((call) => call[1] === 'move')).toEqual(
    expect.arrayContaining(['--split', 'down', '--no-focus']),
  );

  expect(calls.some((call) => call[1] === 'resize' || call[1] === 'focus')).toBe(false);
});

it.each(['moved', 'duplicate', 'missing', 'replacement process'] as const)(
  'protects terminal ownership during %s cleanup',
  async (scenario) => {
    let cleaning = false;
    let closed = false;
    let token = '';

    const { controller, input, calls, fake } = setup(afterTest, 0, async (argumentsList) => {
      if (argumentsList[0] === 'layout') {
        const { command } = (JSON.parse(argumentsList[2]!) as { root: { command: string[] } }).root;

        token = command[command.indexOf('--session') + 1]!;
      }

      if (!cleaning) {
        return '';
      }

      if (argumentsList[0] === 'pane' && argumentsList[1] === 'list') {
        const pane = {
          pane_id: 'other-workspace:pane',
          terminal_id: 'terminal-1',
          workspace_id: 'other-workspace',
          tab_id: 'other-workspace:tab',
        };

        const panes = scenario === 'missing' || closed ? [] : [pane];

        if (scenario === 'duplicate') {
          panes.push({ ...pane, pane_id: 'ambiguous' });
        }

        return JSON.stringify({ result: { panes } });
      }

      if (argumentsList[1] === 'process-info') {
        const processId = scenario === 'replacement process' ? 100 : process.pid;

        return JSON.stringify({
          result: {
            process_info: {
              pane_id: 'other-workspace:pane',
              shell_pid: processId,
              foreground_process_group_id: processId,
              foreground_processes: [{ pid: processId, argv: ['pi', token] }],
            },
          },
        });
      }

      if (argumentsList[0] === 'agent' && argumentsList[1] === 'get') {
        return JSON.stringify({
          result: {
            agent: {
              pane_id: 'other-workspace:pane',
              agent: 'pi',
              agent_session: { value: token },
            },
          },
        });
      }

      if (argumentsList[1] === 'close') {
        closed = true;
        fake.state.stopped = true;

        return '{}';
      }

      return '';
    });

    const launched = await controller.launch(input);
    cleaning = true;
    const previousCalls = calls.length;
    const cancelled = await controller.cancel(launched.taskId, 'parent-id');
    const cleanupCalls = calls.slice(previousCalls);

    expect(cleanupCalls.filter((call) => call[1] === 'close')).toEqual(
      scenario === 'moved' ? [['pane', 'close', 'other-workspace:pane']] : [],
    );

    expect(cleanupCalls.flat()).not.toContain('worker-1');
    expect(cancelled.state).toBe(scenario === 'moved' ? 'stopped' : 'cleanupUnconfirmed');
    expect(cancelled.deadline).toBe(launched.deadline);
  },
);

it('rejects aggregate Unicode tasks before publishing records or creating a pane', async ({
  onTestFinished,
}) => {
  const { directory, controller, input, calls } = setup(onTestFinished);
  const task = '界'.repeat(32_000);
  const loadout = { ...input.loadout, instructions: '界'.repeat(32_000) };

  await expect(controller.launch({ ...input, task, loadout })).rejects.toThrow(
    'Worker record exceeds 128 KB.',
  );

  expect(calls).toEqual([]);

  const directories = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  expect(directories).toHaveLength(0);
  expect(directories.map((name) => readdirSync(join(directory, name)))).toEqual([]);
});

it('launches a fresh worker with saved full-tool settings and recovers without resubmission', async ({
  onTestFinished,
}) => {
  const { directory, controller, calls, input, client } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const task = readTask(launched.directory);
  const header: unknown = JSON.parse(readFileSync(task.nativeSessionFile, 'utf8'));

  expect(header).toMatchObject({
    parentSession: input.parentSession,
    id: task.nativeSessionId,
    type: 'session',
  });

  expect(task.nativeSessionId).not.toBe(task.taskId);
  expect(task.loadout).toEqual(input.loadout);

  expect(workerArguments(task, []).slice(3, 9)).toEqual([
    '--provider',
    'faux',
    '--model',
    'test',
    '--thinking',
    'off',
  ]);

  expect(workerArguments(task, [])).not.toContain('--no-extensions');

  const narrowed = {
    ...task,
    loadout: { ...task.loadout, tools: ['read'], skills: ['/s/SKILL.md'] },
  };

  expect(workerArguments(narrowed, []).slice(9, 14)).toEqual([
    '--tools',
    'read,subagent_progress,subagent_report,subagent_question',
    '--no-skills',
    '--skill',
    '/s/SKILL.md',
  ]);

  expect(launched.state).toBe('starting');
  recordEvent(launched.directory, task.taskId, 'accepted', 'Accepted.');

  acceptReport(launched.directory, task.taskId, {
    taskId: task.taskId,
    outcome: 'success',
    summary: 'Edited fixture.',
    evidence: ['test passed'],
  });

  expect(controller.status(task.taskId, 'parent-id')).toMatchObject({
    state: 'reported',
    outcome: 'success',
    deadline: task.deadline,
  });

  const launches = calls.filter((call) => call[0] === 'layout');
  expect(launches).toHaveLength(1);

  const { root } = JSON.parse(launches[0]?.[2] ?? '') as {
    root: { command: string[]; env: Record<string, string> };
  };

  expect(root.command[0]).toMatch(/^\/.*\/pi$/);
  expect(root.command.slice(1)).toEqual(workerArguments(task, []));

  expect(root.env).toMatchObject({
    TAU_WORKER_RECORD: launched.directory,
    PI_CODING_AGENT_DIR: task.loadout.agentDirectory,
  });

  controller.close();
  const recovered = new WorkerController(directory, client);

  onTestFinished(() => {
    recovered.close();
  });

  expect(recovered.status(task.taskId, 'parent-id')).toMatchObject({
    state: 'cleanupUnconfirmed',
    recovery: {
      paneId: 'worker-1',
      directory: launched.directory,
      nativeSessionFile: task.nativeSessionFile,
    },
  });

  expect(recovered.status(task.taskId, 'parent-id').report?.summary).toBe('Edited fixture.');
  expect(() => recovered.status(task.taskId, 'wrong-parent')).toThrow('another parent');

  for (const [taskId, parentSessionId] of [
    [task.taskId, 'wrong-parent'],
    ['missing-task', 'parent-id'],
    ['../escape', 'parent-id'],
  ] as const) {
    let refusal: unknown = null;

    try {
      recovered.status(taskId, parentSessionId);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(EvidenceUnavailableError);
    expect(String(refusal)).not.toContain(dirname(launched.directory));
  }

  expect(await recovered.cancel(task.taskId, 'parent-id')).toMatchObject({
    state: 'stopped',
    outcome: 'cancelled',
  });
});

it('recovers reports and native references without extension discovery metadata', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const task = readTask(launched.directory);

  acceptReport(launched.directory, task.taskId, {
    taskId: task.taskId,
    outcome: 'success',
    summary: 'Saved HEAD handover.',
    evidence: ['existing evidence'],
  });

  controller.close();
  const recovered = new WorkerController(directory);

  onTestFinished(() => {
    recovered.close();
  });

  expect(recovered.status(task.taskId, 'parent-id')).toMatchObject({
    outcome: 'success',
    state: 'cleanupUnconfirmed',
    nativeSessionId: task.nativeSessionId,
    nativeSessionFile: task.nativeSessionFile,
    report: { summary: 'Saved HEAD handover.' },
  });

  expect(workerArguments(readTask(launched.directory), [])).toEqual(workerArguments(task, []));
});

it('reports corrupt launch evidence without stopping dispatched work until cancelled', async ({
  onTestFinished,
}) => {
  let recordDirectory = '';

  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[0] === 'layout') {
      recordDirectory = (JSON.parse(argumentsList[2]!) as { root: { env: Record<string, string> } })
        .root.env.TAU_WORKER_RECORD!;

      writeFileSync(join(recordDirectory, 'report.json'), '{');
    }

    return '';
  });

  await expect(controller.launch(input)).rejects.toThrow('saved evidence is unavailable');
  const taskId = readTask(recordDirectory).taskId;

  expect(readdirSync(recordDirectory)).toContain('dispatch.json');
  expect(readdirSync(recordDirectory)).not.toContain('stopping.json');
  expect(calls.filter((call) => call[1] === 'close')).toHaveLength(0);
  expect(controller.owns(taskId)).toBe(true);

  await expect(controller.cancel(taskId, 'parent-id')).rejects.toBeInstanceOf(
    EvidenceUnavailableError,
  );

  expect(calls.filter((call) => call[1] === 'close')).toHaveLength(1);
  expect(readEvent(recordDirectory, taskId, 'cleanup')).toBeDefined();
  expect(readFileSync(join(recordDirectory, 'report.json'), 'utf8')).toBe('{');
});

it('only lets the owning parent cancel work after a status evidence failure', async ({
  onTestFinished,
}) => {
  const { controller, input, calls, notifications } = setup(onTestFinished);
  const launched = await controller.launch(input);
  writeFileSync(join(launched.directory, 'report.json'), '{');

  const callCount = calls.length;

  expect(() => controller.status(launched.taskId, 'another-parent')).toThrow(
    'another parent session',
  );

  expect(calls).toHaveLength(callCount);
  const evidenceFailure = captureError(() => controller.status(launched.taskId, 'parent-id'));

  expect(String(evidenceFailure)).toContain('saved evidence is unavailable');
  expect(String(evidenceFailure)).not.toContain(launched.nativeSessionFile);
  expect(evidenceFailure).toBeInstanceOf(EvidenceUnavailableError);

  expect((evidenceFailure as EvidenceUnavailableError).recovery).toMatchObject({
    directory: launched.directory,
    nativeSessionFile: launched.nativeSessionFile,
  });

  expect((evidenceFailure as Error).message).not.toContain(launched.directory);
  expect(readdirSync(launched.directory)).not.toContain('stopping.json');
  expect(calls.filter((call) => call[1] === 'close')).toHaveLength(0);

  await expect(controller.cancel(launched.taskId, 'another-parent')).rejects.toThrow(
    'another parent session',
  );

  expect(calls.filter((call) => call[1] === 'close')).toHaveLength(0);

  await expect(controller.cancel(launched.taskId, 'parent-id')).rejects.toBeInstanceOf(
    EvidenceUnavailableError,
  );

  expect(calls.filter((call) => call[1] === 'close')).toHaveLength(1);
  expect(readEvent(launched.directory, launched.taskId, 'cleanup')).toBeDefined();
  expect(JSON.stringify(notifications[0]?.content)).toContain(launched.nativeSessionId);
});

it('cancels a live owned worker whose saved cleanup record is corrupt', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished);
  const launched = await controller.launch(input);
  writeFileSync(join(launched.directory, 'cleanup.json'), '{');

  await expect(controller.cancel(launched.taskId, 'parent-id')).rejects.toBeInstanceOf(
    EvidenceUnavailableError,
  );

  expect(calls.filter((call) => call[1] === 'close')).toHaveLength(1);
  expect(readdirSync(launched.directory)).toContain('stopping.json');
});

it('keeps capacity free when a stopped worker is cancelled again', async ({ onTestFinished }) => {
  vi.stubEnv('TAU_SUBAGENT_CAP', '1');
  const { controller, input } = setup(onTestFinished);
  const first = await controller.launch(input);

  await controller.cancel(first.taskId, 'parent-id');
  await controller.cancel(first.taskId, 'parent-id');
  const next = await controller.launch(input);

  expect(controller.owns(next.taskId)).toBe(true);
});

it('reads the worker directory once per widget refresh', async ({ onTestFinished }) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);
  await controller.launch(input);
  await controller.launch(input);
  const root = dirname(launched.directory);
  vi.mocked(readdirSync).mockClear();

  expect(controller.widgetRows('parent-id')).toHaveLength(3);
  expect(vi.mocked(readdirSync).mock.calls.filter(([path]) => path === root)).toHaveLength(1);
});

it('reads status, history, and widget rows without writing records or stopping workers', async ({
  onTestFinished,
}) => {
  const { controller, input, calls, directory } = setup(onTestFinished);
  const launched = await controller.launch(input);

  const snapshot = () =>
    readdirSync(launched.directory)
      .toSorted()
      .map((name) => [name, readFileSync(join(launched.directory, name), 'utf8')]);

  const before = snapshot();
  const callCount = calls.length;

  controller.status(launched.taskId, 'parent-id');
  controller.widgetRows('parent-id');

  await searchHistory(
    directory,
    { file: join(directory, 'parent.jsonl'), id: 'parent-id', sessionDirectory: directory },
    '',
    (taskId) => controller.owns(taskId),
  );

  expect(snapshot()).toEqual(before);

  writeFileSync(join(launched.directory, 'report.json'), '{');
  const corrupt = snapshot();

  expect(() => controller.status(launched.taskId, 'parent-id')).toThrow(EvidenceUnavailableError);
  controller.widgetRows('parent-id');

  expect(snapshot()).toEqual(corrupt);
  expect(calls.slice(callCount).filter((call) => call[1] === 'close')).toHaveLength(0);
});

it('reads worker activity into status without writing records or stopping workers', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const activityPath = join(launched.directory, 'activity.json');

  const snapshot = () =>
    readdirSync(launched.directory)
      .toSorted()
      .map((name) => [name, readFileSync(join(launched.directory, name), 'utf8')]);

  const callCount = calls.length;

  rmSync(activityPath, { force: true });
  let before = snapshot();
  expect(controller.status(launched.taskId, 'parent-id').activity).toBeUndefined();
  expect(snapshot()).toEqual(before);

  writeWorkerActivity(launched.directory, {
    taskId: launched.taskId,
    sequence: 1,
    updatedAt: 5,
    phase: 'active',
    description: 'Fixing status counts',
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  });

  before = snapshot();

  expect(controller.status(launched.taskId, 'parent-id').activity).toMatchObject({
    phase: 'active',
    description: 'Fixing status counts',
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  });

  expect(snapshot()).toEqual(before);

  for (const malformed of ['{', JSON.stringify({ taskId: launched.taskId, phase: 'lost' })]) {
    writeFileSync(activityPath, malformed);
    before = snapshot();
    expect(controller.status(launched.taskId, 'parent-id').activity).toBeUndefined();
    expect(snapshot()).toEqual(before);
  }

  expect(calls.slice(callCount).filter((call) => call[1] === 'close')).toHaveLength(0);
});

it('keeps the original deadline and reports active-work cancellation failure honestly', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();

  const { controller, calls, input, notifications } = setup(
    onTestFinished,
    0,
    async (argumentsList) => {
      if (argumentsList[1] === 'close') {
        throw new Error('Injected herdr failure; the worker remains.');
      }

      return '';
    },
  );

  const launched = await controller.launch(input);
  await vi.advanceTimersByTimeAsync(5000);
  expect(controller.status(launched.taskId, 'parent-id').deadline).toBe(launched.deadline);
  vi.setSystemTime(Date.now() - 60_000);
  await vi.advanceTimersByTimeAsync(2600);
  await controller.cancel(launched.taskId, 'parent-id');
  const status = controller.status(launched.taskId, 'parent-id');

  expect(status.outcome).toBe('timeout');
  expect(status.state).toBe('cleanupUnconfirmed');
  expect(status.recovery?.paneId).toBe('worker-1');
  expect(status.cleanup).toContain('manual cleanup');
  expect(calls.filter((call) => call[1] === 'close')).toHaveLength(1);
  expect(notifications).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(notifications).toHaveLength(1);
});

it('keeps a failed timeout notice in worker status once', async ({ onTestFinished }) => {
  vi.useFakeTimers();
  const { directory, client, input } = setup(onTestFinished);

  const controller = new WorkerController(directory, client, () => {
    throw new Error('Injected notice failure.');
  });

  onTestFinished(() => {
    controller.close();
  });

  const launched = await controller.launch(input);
  await vi.advanceTimersByTimeAsync(20_000);

  expect(readEvent(launched.directory, launched.taskId, 'timeout')).toBeDefined();

  let failure = '';

  try {
    controller.status(launched.taskId, 'parent-id');
  } catch (error) {
    failure = String(error);
  }

  // The notice failure appears exactly once.
  expect(failure.split('Injected notice failure.')).toHaveLength(2);
});

it('preserves incomplete output and malformed evidence without retrying startup', async ({
  onTestFinished,
}) => {
  const { directory, input } = setup(onTestFinished);
  const calls: string[][] = [];

  const controller = new WorkerController(directory, async (argumentsList) => {
    calls.push(argumentsList);

    if (argumentsList[1] === 'list') {
      return JSON.stringify({ result: { type: 'agent_list', agents: [] } });
    }

    throw new Error('Startup unavailable');
  });

  onTestFinished(() => {
    controller.close();
  });

  const status = await controller.launch(input);

  expect(status).toMatchObject({
    outcome: 'failure',
    state: 'stopped',
  });

  expect(calls.map((call) => call[1])).toEqual(['list', 'current']);
  expect(readdirSync(status.directory)).toContain('task.json');
  writeFileSync(join(status.directory, 'report.json'), '{');
  expect(() => taskStatus(status.directory)).toThrow(/JSON|property/);
});

it('distinguishes settled missing handover and cancellation from success', async ({
  onTestFinished,
}) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);

  recordEvent(launched.directory, launched.taskId, 'settled', {
    detail: 'Stopped without report.',
    stopped: true,
  });

  expect(taskStatus(launched.directory)).toMatchObject({
    outcome: 'incomplete',
    state: 'cleanupUnconfirmed',
  });

  const cancelled = await controller.cancel(launched.taskId, 'parent-id');
  expect(cancelled.outcome).toBe('cancelled');
});

it('includes prior loadout resolution in the original task deadline', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const { controller, input } = setup(onTestFinished);
  const startedAt = { wall: Date.now() - 2000, monotonic: performance.now() - 2000 };
  const launched = await controller.launch({ ...input, startedAt });

  expect(launched.deadline).toBe(startedAt.wall + input.timeout);
  await vi.advanceTimersByTimeAsync(5600);
  await controller.cancel(launched.taskId, 'parent-id');
  expect(controller.status(launched.taskId, 'parent-id').outcome).toBe('timeout');
});

it.each(['fails', 'aborts', 'times out'] as const)(
  'stops Pi when the launch reply %s after herdr started it',
  async (outcome) => {
    const abort = new AbortController();

    const fixture = setup(afterTest, -1, async (argumentsList, budget, signal) => {
      if (argumentsList[0] !== 'layout') {
        return '';
      }

      // Herdr starts the worker, but its reply never reaches Tau.
      await fixture.fake.client(argumentsList, budget, signal);

      if (outcome === 'aborts') {
        abort.abort();
      }

      throw new Error(
        outcome === 'times out'
          ? 'Client attempt budget expired; delivery and cleanup are unconfirmed.'
          : 'Launch reply lost',
      );
    });

    const launched = await fixture.controller.launch(fixture.input, abort.signal);

    expect(launched.state).toBe('stopped');

    expect(fixture.calls.filter((call) => call[1] === 'close')).toEqual([
      ['pane', 'close', 'worker-1'],
    ]);

    expect(fixture.fake.layout.panes.map((pane) => pane.pane_id)).toEqual(['parent']);
  },
);

it('confirms no worker started when the launch request never reached herdr', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished, -1, async (argumentsList) => {
    if (argumentsList[0] === 'layout') {
      throw new RequestNotSentError('herdr did not receive the request.');
    }

    return '';
  });

  const launched = await controller.launch(input);

  expect(launched).toMatchObject({ state: 'stopped', outcome: 'failure' });
  expect(launched.cleanup).toContain('No worker was started');
  expect(calls.some((call) => ['process-info', 'close'].includes(call[1] ?? ''))).toBe(false);
});

it('waits for an in-flight launch before confirming shutdown cleanup', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const fixture = setup(onTestFinished, -1);
  const enteredStart = Promise.withResolvers<undefined>();
  const client = fixture.fake.client;

  vi.spyOn(fixture.fake, 'client').mockImplementation(async (argumentsList, budget, signal) => {
    if (argumentsList[0] === 'layout') {
      enteredStart.resolve(undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return client(argumentsList, budget, signal);
  });

  const launching = fixture.controller.launch(fixture.input);
  await enteredStart.promise;
  const shutdown = fixture.controller.stopAll('reload');
  await vi.advanceTimersByTimeAsync(100);
  await shutdown;
  const launched = await launching;

  expect(fixture.fake.state.stopped).toBe(true);
  expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(true);
  expect(fixture.fake.layout.panes.map((pane) => pane.pane_id)).toEqual(['parent']);
});

it('refuses a prepared launch while shutdown is still draining workers', async ({
  onTestFinished,
}) => {
  const listingEntered = Promise.withResolvers<undefined>();
  const releaseListing = Promise.withResolvers<undefined>();
  const cleanupEntered = Promise.withResolvers<undefined>();
  const releaseCleanup = Promise.withResolvers<undefined>();
  let pauseListing = false;
  let pauseCleanup = false;

  const fixture = setup(onTestFinished, 0, async (argumentsList) => {
    if (pauseListing && argumentsList[0] === 'agent' && argumentsList[1] === 'list') {
      pauseListing = false;
      listingEntered.resolve(undefined);
      await releaseListing.promise;
    }

    if (pauseCleanup && argumentsList[0] === 'pane' && argumentsList[1] === 'list') {
      pauseCleanup = false;
      cleanupEntered.resolve(undefined);
      await releaseCleanup.promise;
    }

    return '';
  });

  onTestFinished(() => {
    releaseListing.resolve(undefined);
    releaseCleanup.resolve(undefined);
  });

  await fixture.controller.launch(fixture.input);
  const recordsBefore = readdirSync(fixture.directory);
  const panesBefore = structuredClone(fixture.fake.layout.panes);
  pauseListing = true;
  const launching = fixture.controller.launch(fixture.input).catch((error: unknown) => error);
  await listingEntered.promise;
  pauseCleanup = true;
  const shutdown = fixture.controller.stopAll('reload');
  await cleanupEntered.promise;
  releaseListing.resolve(undefined);
  const launchResult = await launching;
  const recordsAfter = readdirSync(fixture.directory);
  const panesAfter = structuredClone(fixture.fake.layout.panes);
  releaseCleanup.resolve(undefined);
  await shutdown;

  expect(launchResult).toBeInstanceOf(Error);
  expect(String(launchResult)).toContain('Parent controller stopped');
  expect(recordsAfter).toEqual(recordsBefore);
  expect(panesAfter).toEqual(panesBefore);
  expect(fixture.calls.filter((call) => call[0] === 'layout')).toHaveLength(1);
});

it('caps live workers per controller and admits again after confirmed cleanup', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_SUBAGENT_CAP', '1');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const fixture = setup(onTestFinished);
  vi.stubEnv('TAU_SUBAGENT_CAP', '2');

  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (fixture.fake.state.stopped) {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    }

    return true;
  });

  const launched = await fixture.controller.launch(fixture.input);
  const recordsBefore = readdirSync(fixture.directory);
  const panesBefore = structuredClone(fixture.fake.layout.panes);
  const refused = fixture.controller.launch(fixture.input);

  await expect(refused).rejects.toThrow('capacity full');
  await expect(refused).rejects.toThrow(launched.name);
  await expect(refused).rejects.toThrow(new Date(launched.deadline).toISOString());

  expect(readdirSync(fixture.directory)).toEqual(recordsBefore);
  expect(fixture.fake.layout.panes).toEqual(panesBefore);
  expect(fixture.calls.filter((call) => call[0] === 'layout')).toHaveLength(1);
  await fixture.controller.cancel(launched.taskId, fixture.input.parentSessionId);
  fixture.fake.state.stopped = false;
  const replacement = await fixture.controller.launch(fixture.input);

  expect(replacement.state).toBe('starting');
  expect(fixture.calls.filter((call) => call[0] === 'layout')).toHaveLength(2);
});

it('admits another worker after cleanup fails its terminal identity check', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_SUBAGENT_CAP', '1');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);
  fixture.fake.layout.panes[1]!.terminal_id = 'replacement-terminal';
  const callsBefore = fixture.calls.length;

  const cancelled = await fixture.controller.cancel(launched.taskId, fixture.input.parentSessionId);

  expect(cancelled).toMatchObject({
    state: 'cleanupUnconfirmed',
    recovery: {
      directory: launched.directory,
      nativeSessionFile: launched.nativeSessionFile,
      paneId: 'worker-1',
    },
  });

  expect(fixture.calls.slice(callsBefore).filter((call) => call[1] === 'close')).toEqual([]);

  const replacement = await fixture.controller.launch(fixture.input);

  expect(replacement.state).toBe('starting');

  expect(fixture.controller.status(launched.taskId, fixture.input.parentSessionId)).toMatchObject({
    state: 'cleanupUnconfirmed',
    recovery: cancelled.recovery,
  });
});

it('stops running workers and frees their slots on reload', async ({ onTestFinished }) => {
  const fixture = setup(onTestFinished);

  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (fixture.fake.state.stopped) {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    }

    return true;
  });

  const launched = await fixture.controller.launch(fixture.input);

  await fixture.controller.stopAll('reload');

  expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.detail).toContain(
    'Parent session reload',
  );

  expect(fixture.controller.status(launched.taskId, fixture.input.parentSessionId).state).toBe(
    'stopped',
  );

  expect(fixture.fake.layout.panes.map((pane) => pane.pane_id)).toEqual(['parent']);

  await expect(fixture.controller.launch(fixture.input)).rejects.toThrow(
    'Parent controller stopped',
  );
});

it('bounds reload cleanup by the remaining cancellation budget', async ({ onTestFinished }) => {
  let cleaning = false;

  const fixture = setup(onTestFinished, 0, async (argumentsList, _budget, signal) => {
    if (cleaning && argumentsList[0] === 'pane' && argumentsList[1] === 'list') {
      return new Promise<string>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('Cleanup deadline reached'));
          },
          { once: true },
        );
      });
    }

    return '';
  });

  // The smallest task that still leaves herdr a valid start timeout has a 1500 ms cleanup budget.
  const launched = await fixture.controller.launch({ ...fixture.input, timeout: 6000 });
  cleaning = true;
  const began = performance.now();

  await fixture.controller.stopAll('reload');

  expect(performance.now() - began).toBeLessThan(2500);
  const cleanup = readEvent(launched.directory, launched.taskId, 'cleanup');
  expect(cleanup?.stopped).toBe(false);
  expect(cleanup?.detail).toContain('Parent session reload');
});

it('ends enforcement on parent shutdown without claiming cleanup', async ({ onTestFinished }) => {
  vi.useFakeTimers();
  const { controller, calls, input, notifications } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const callCount = calls.length;

  controller.close();
  await vi.advanceTimersByTimeAsync(20_000);

  const status = controller.status(launched.taskId, 'parent-id');
  expect(status.state).toBe('notOwned');
  expect(status).not.toHaveProperty('outcome');
  expect(calls).toHaveLength(callCount);
  expect(notifications).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('ends in-flight cleanup on parent shutdown without further calls or notification', async ({
  onTestFinished,
}) => {
  const entered = Promise.withResolvers<AbortSignal>();
  const released = Promise.withResolvers<string>();
  let cleaning = false;

  const { controller, input, calls, notifications } = setup(
    onTestFinished,
    0,
    async (_arguments, _budget, signal) => {
      if (!cleaning || !signal) {
        return '';
      }

      entered.resolve(signal);

      return released.promise;
    },
  );

  const launched = await controller.launch(input);
  cleaning = true;
  const cancellation = controller.cancel(launched.taskId, 'parent-id');
  const signal = await entered.promise;
  const callCount = calls.length;

  controller.close();
  const abortedOnClose = signal.aborted;
  released.resolve(JSON.stringify({ result: { process_info: {} } }));
  await cancellation;

  expect(abortedOnClose).toBe(true);
  expect(calls).toHaveLength(callCount);
  expect(notifications).toEqual([]);

  expect(controller.status(launched.taskId, 'parent-id')).toMatchObject({
    outcome: 'cancelled',
    state: 'cleanupUnconfirmed',
  });

  expect(controller.status(launched.taskId, 'parent-id').cleanup).toContain('manual cleanup');
});

it('refuses expired work and invalid deadlines before creating a pane', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished);

  const startedAt = {
    wall: Date.now() - input.timeout,
    monotonic: performance.now() - input.timeout,
  };

  await expect(controller.launch({ ...input, startedAt })).rejects.toThrow('work budget expired');

  for (const timeout of [0, -1, Number.NaN, 2_147_483_648]) {
    await expect(controller.launch({ ...input, timeout })).rejects.toThrow(
      /work budget expired|Invalid fixed worker deadline/,
    );
  }

  expect(calls).toEqual([]);
});

it('rejects invalid model and thinking in saved loadouts without replacing the task', async ({
  onTestFinished,
}) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const path = join(launched.directory, 'task.json');
  const task = readTask(launched.directory);

  for (const invalid of [{ model: 'missing-provider' }, { thinking: 'invalid' }]) {
    writeFileSync(path, JSON.stringify({ ...task, loadout: { ...task.loadout, ...invalid } }));
    expect(() => readTask(launched.directory)).toThrow('Invalid saved worker task or loadout');
  }

  writeFileSync(path, JSON.stringify(task));
  expect(readTask(launched.directory).loadout).toEqual(input.loadout);
});

it('closes the launched pane by its session argument when process inspection fails', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished, -1);

  vi.spyOn(cancellationModule, 'runClient').mockRejectedValue(
    new Error('Process inspection failed.'),
  );

  const status = await controller.launch(input);

  expect(status).toMatchObject({ outcome: 'failure', state: 'stopped' });
  expect(status.failure).toContain('Process inspection failed.');
  expect(readEvent(status.directory, status.taskId, 'cleanup')?.stopped).toBe(true);
  expect(calls.filter((call) => call[0] === 'layout')).toHaveLength(1);
  expect(calls.filter((call) => call[1] === 'close')).toEqual([['pane', 'close', 'worker-1']]);
});

it('reports a worker that exits while Tau establishes its identity as exited', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished, -1, async (argumentsList) => {
    // Pi exits and herdr removes its pane while the first identity check runs.
    if (argumentsList[1] === 'process-info') {
      fixture.fake.state.stopped = true;

      throw new Error('Command failed: herdr pane process-info');
    }

    return '';
  });

  const status = await fixture.controller.launch(fixture.input);

  expect(status).toMatchObject({ outcome: 'failure', state: 'stopped' });
  expect(status.failure).toContain('exited before readiness');
});

it('detects an owned worker exiting before readiness without waiting for the task deadline', async ({
  onTestFinished,
}) => {
  let inspections = 0;

  const fixture = setup(onTestFinished, -1, async (argumentsList) => {
    // Herdr removes the pane when its worker exits.
    if (argumentsList[1] === 'process-info' && ++inspections > 1) {
      fixture.fake.state.stopped = true;
    }

    return '';
  });

  const { controller, input, calls } = fixture;
  const started = performance.now();
  const status = await controller.launch({ ...input, timeout: 60_000 });

  expect(performance.now() - started).toBeLessThan(1500);
  expect(status).toMatchObject({ outcome: 'failure', state: 'stopped' });
  expect(status.failure).toContain('exited before readiness');
  expect(calls.filter((call) => call[0] === 'layout')).toHaveLength(1);
  expect(calls.some((call) => call[1] === 'close')).toBe(false);
});

it.each(['missing report', 'accepted report'])(
  'detects post-readiness exit with %s before the deadline',
  async (reportState) => {
    vi.useFakeTimers();
    const { controller, input, calls, notifications, fake } = setup(afterTest);

    const launched = await controller.launch({ ...input, timeout: 60_000 });
    recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');

    const report = {
      taskId: launched.taskId,
      outcome: 'success',
      summary: 'Saved handover.',
      evidence: ['source.ts:1'],
    };

    if (reportState === 'accepted report') {
      acceptReport(launched.directory, launched.taskId, report);
    }

    fake.state.stopped = true;

    await vi.advanceTimersByTimeAsync(250);

    expect(controller.status(launched.taskId, 'parent-id')).toMatchObject({
      outcome: reportState === 'accepted report' ? 'success' : 'incomplete',
      state: 'stopped',
      report: reportState === 'accepted report' ? report : undefined,
    });

    expect(notifications).toHaveLength(1);
    expect(calls.filter((call) => call[0] === 'layout')).toHaveLength(1);
    // Herdr removed the pane with its worker.
    expect(calls.some((call) => call[1] === 'close')).toBe(false);
  },
);

it('cleans up an owned live pane even when startup failure evidence is corrupt', async ({
  onTestFinished,
}) => {
  let recordDirectory = '';

  const { controller, input, calls, notifications } = setup(
    onTestFinished,
    0,
    async (argumentsList) => {
      if (argumentsList[0] === 'layout') {
        recordDirectory = (
          JSON.parse(argumentsList[2]!) as { root: { env: Record<string, string> } }
        ).root.env.TAU_WORKER_RECORD!;

        writeFileSync(join(recordDirectory, 'startupFailure.json'), '{');
      }

      return '';
    },
  );

  const launch = controller.launch(input);
  await expect(launch).rejects.toThrow(/records|evidence/i);
  const task = readTask(recordDirectory);
  expect(JSON.stringify(notifications)).toContain(task.nativeSessionId);
  expect(JSON.stringify(notifications)).toContain(task.nativeSessionFile);
  expect(calls.filter((call) => call[1] === 'close')).toHaveLength(1);
  expect(readFileSync(join(recordDirectory, 'startupFailure.json'), 'utf8')).toBe('{');
  expect(JSON.stringify(notifications)).toContain('worker-1');
  expect(JSON.stringify(notifications)).toMatch(/records|evidence/i);
  const evidence = notifications.find((notice) => 'evidenceError' in notice.content);
  expect(evidence).toBeDefined();

  expect(Object.keys(evidence?.content ?? {}).toSorted()).toEqual(
    ['taskId', 'name', 'evidenceError', 'recovery'].toSorted(),
  );

  expect(evidence?.content).not.toHaveProperty('state');
  expect(evidence?.content).not.toHaveProperty('outcome');
});

it('reports both startup and receipt failures after attempting owned pane cleanup', async ({
  onTestFinished,
}) => {
  let inspections = 0;

  const { controller, input, calls, notifications } = setup(
    onTestFinished,
    -1,
    async (argumentsList) => {
      if (argumentsList[1] === 'process-info' && ++inspections === 2) {
        throw new Error('Injected worker identity probe failure');
      }

      return '';
    },
  );

  const original = records.recordEvent;

  vi.spyOn(records, 'recordEvent').mockImplementation((...argumentsList) => {
    if (argumentsList[2] === 'startupFailure') {
      throw new Error('Injected startup receipt write failure');
    }

    original(...argumentsList);
  });

  const launch = controller.launch(input);

  await expect(launch).rejects.toThrow('Injected startup receipt write failure');
  await expect(launch).rejects.toThrow('Injected worker identity probe failure');
  expect(calls.filter((call) => call[1] === 'close')).toHaveLength(1);
  expect(JSON.stringify(notifications)).toContain('Injected startup receipt write failure');
  expect(JSON.stringify(notifications)).toContain('Injected worker identity probe failure');
  expect(JSON.stringify(notifications)).toContain('worker-1');
});

it.each(['cancelled', 'timeout'] as const)(
  'stops an owned live pane before reporting a failed %s receipt write',
  async (reason) => {
    vi.useFakeTimers();
    const { controller, input, calls, notifications } = setup(afterTest);
    const launched = await controller.launch(input);
    writeFileSync(join(launched.directory, 'report.json'), '{');
    const original = records.recordEvent;

    vi.spyOn(records, 'recordEvent').mockImplementation((...argumentsList) => {
      if (argumentsList[2] === reason) {
        throw new Error('Injected receipt write failure');
      }

      original(...argumentsList);
    });

    if (reason === 'timeout') {
      await vi.advanceTimersByTimeAsync(7600);
    }

    await expect(controller.cancel(launched.taskId, 'parent-id')).rejects.toThrow(
      /records|evidence/i,
    );

    expect(calls.filter((call) => call[1] === 'close')).toHaveLength(1);
    expect(JSON.stringify(notifications)).toContain('Injected receipt write failure');
    expect(JSON.stringify(notifications)).toContain('worker-1');
    expect(readFileSync(join(launched.directory, 'report.json'), 'utf8')).toBe('{');
  },
);

it('uses in-memory ownership to cancel even when the saved task is corrupt', async ({
  onTestFinished,
}) => {
  const { controller, input, calls, notifications } = setup(onTestFinished);
  const launched = await controller.launch(input);
  writeFileSync(join(launched.directory, 'task.json'), '{');

  const cancelled = controller.cancel(launched.taskId, 'parent-id');
  await expect(cancelled).rejects.toThrow(/evidence/);
  expect(calls.filter((call) => call[1] === 'close')).toHaveLength(1);
  expect(JSON.stringify(notifications)).toContain('worker-1');
  expect(readFileSync(join(launched.directory, 'task.json'), 'utf8')).toBe('{');
});

it('distinguishes missing readiness timeout from startup failure inside the original deadline', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const monitoring = Promise.withResolvers<undefined>();
  const budgets: number[] = [];
  let inspections = 0;

  const { controller, input, calls } = setup(
    onTestFinished,
    -1,
    async (argumentsList, budget, signal) => {
      budgets.push(budget);

      if (argumentsList[1] === 'process-info' && ++inspections === 2) {
        monitoring.resolve(undefined);

        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('Client aborted'));
            },
            { once: true },
          );
        });
      }

      return '';
    },
  );

  const launch = controller.launch(input);
  await monitoring.promise;
  await vi.advanceTimersByTimeAsync(7600);
  const status = await launch;

  expect(budgets.length).toBeGreaterThan(0);

  for (const budget of budgets) {
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(7500);
  }

  expect(status).toMatchObject({
    outcome: 'timeout',
    state: 'stopped',
    failure: undefined,
  });

  expect(calls.filter((call) => call[0] === 'layout')).toHaveLength(1);
  expect(readdirSync(status.directory)).not.toContain('dispatch.json');
});

it('polls slow worker readiness at 250 ms intervals', async ({ onTestFinished }) => {
  vi.spyOn(cancellationModule, 'runClient').mockResolvedValue('fixture start');
  const polled = Promise.withResolvers<undefined>();
  const inspections: number[] = [];

  const { controller, input } = setup(onTestFinished, -1, async (argumentsList) => {
    if (argumentsList[1] === 'process-info') {
      inspections.push(performance.now());

      if (inspections.length === 3) {
        polled.resolve(undefined);
      }
    }

    return '';
  });

  const launch = controller.launch(input);
  await polled.promise;
  controller.close();
  await launch;

  expect(inspections).toHaveLength(3);
  expect(inspections[2]! - inspections[1]!).toBeGreaterThanOrEqual(200);
  expect(inspections[2]! - inspections[1]!).toBeLessThan(1500);
});

it('reports recovered corrupt task evidence without its directory or native identity', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const launched = await controller.launch(input);
  controller.close();
  writeFileSync(join(launched.directory, 'task.json'), '{');
  const recovered = new WorkerController(directory);

  onTestFinished(() => {
    recovered.close();
  });

  const evidenceError = String(captureError(() => recovered.status(launched.taskId, 'parent-id')));

  expect(evidenceError).toContain('saved evidence is unavailable');
  expect(evidenceError).toContain('manually');
  expect(evidenceError).not.toContain(launched.directory);
  expect(evidenceError).not.toContain('Native session unavailable');
});

it('carries saved recovery when a handle-free status finds corrupt report evidence', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const task = readTask(launched.directory);
  controller.close();
  writeFileSync(join(launched.directory, 'report.json'), '{');
  const recovered = new WorkerController(directory);

  onTestFinished(() => {
    recovered.close();
  });

  const evidenceFailure = captureError(() => recovered.status(launched.taskId, 'parent-id'));

  expect(evidenceFailure).toBeInstanceOf(EvidenceUnavailableError);

  expect((evidenceFailure as EvidenceUnavailableError).recovery).toEqual({
    directory: launched.directory,
    nativeSessionFile: task.nativeSessionFile,
  });

  expect((evidenceFailure as Error).message).not.toContain(launched.directory);
  expect((evidenceFailure as Error).message).not.toContain(task.nativeSessionFile);
});

it('waits for worker readiness after launch without a new startup budget', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const started = Promise.withResolvers<undefined>();

  const { controller, input, calls } = setup(onTestFinished, 100, async (argumentsList) => {
    if (argumentsList[0] === 'layout') {
      started.resolve(undefined);
    }

    return '';
  });

  const launch = controller.launch(input);
  await started.promise;
  await vi.advanceTimersByTimeAsync(150);
  const status = await launch;

  expect(status.failure).toBeUndefined();
  expect(status.state).toBe('starting');
  expect(status).not.toHaveProperty('outcome');
  expect(calls.filter((call) => call[0] === 'layout')).toHaveLength(1);
});

it('exposes read-only widget rows without inferring success from worker readiness', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);
  writeFileSync(join(launched.directory, 'activity.json'), '{malformed');
  const before = readdirSync(launched.directory).toSorted();
  const [starting] = fixture.controller.widgetRows(fixture.input.parentSessionId);

  if (!starting) {
    throw new TypeError('Expected the launched worker in the widget.');
  }

  expect(starting.name).toMatch(/^(worker|scout)-[a-z0-9]{2}$/);

  expect(starting).toMatchObject({
    state: 'starting',
    model: 'requested faux/test · observed unavailable',
    usage: { available: false, reason: 'Pi session usage was not recorded' },
  });

  expect(starting).not.toHaveProperty('outcome');
  expect(readdirSync(launched.directory).toSorted()).toEqual(before);
  expect(readEvent(launched.directory, launched.taskId, 'settled')).toBeUndefined();

  writeWorkerActivity(launched.directory, {
    taskId: launched.taskId,
    sequence: 1,
    updatedAt: Date.now() - 60_001,
    phase: 'active',
    label: 'tool: read',
  });

  expect(fixture.controller.widgetRows(fixture.input.parentSessionId)[0]).toMatchObject({
    state: 'starting',
    activity: 'Pi activity stale',
  });

  questions.acceptQuestion(launched.directory, launched.taskId, {
    version: 1,
    taskId: launched.taskId,
    questionId: 'question-1',
    question: 'Which behavior should the test cover?',
  });

  expect(fixture.controller.widgetRows(fixture.input.parentSessionId)[0]).toMatchObject({
    state: 'awaitingReply',
    question: 'Which behavior should the test cover?',
  });

  questions.acceptReply(launched.directory, launched.taskId, {
    version: 1,
    taskId: launched.taskId,
    questionId: 'question-1',
    replyId: 'reply-1',
    reply: 'Cover the visible widget behavior.',
  });

  expect(fixture.controller.widgetRows(fixture.input.parentSessionId)[0]).not.toHaveProperty(
    'question',
  );

  records.acceptReport(launched.directory, launched.taskId, {
    taskId: launched.taskId,
    outcome: 'success',
    summary: 'Finished.',
    evidence: [],
  });

  recordEvent(launched.directory, launched.taskId, 'cleanup', {
    detail: 'Parent confirmed.',
    stopped: true,
  });

  const stoppedRow = fixture.controller.widgetRows(fixture.input.parentSessionId)[0];

  expect(stoppedRow).toMatchObject({
    state: 'stopped',
    outcome: 'success',
    terminal: 'success',
    cleanupConfirmed: true,
  });

  if (stoppedRow?.stoppedAt === undefined) {
    throw new Error('Confirmed cleanup must preserve its terminal timestamp.');
  }

  expect(stoppedRow.stoppedAt).toBeGreaterThan(0);
  expect(stoppedRow.detailPath).toBe(join(launched.directory, 'report.json'));
});

it('refreshes worker history after cleanup', async ({ onTestFinished }) => {
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);
  const task = readTask(launched.directory);

  for (let index = 0; index < 3; index++) {
    const historical = { ...task, taskId: `history-${index}`, name: `worker-${index}0` };
    const directory = join(fixture.directory, historical.taskId);
    mkdirSync(directory);
    records.publish(directory, 'task.json', historical);
    recordEvent(directory, historical.taskId, 'cleanup', { stopped: true, detail: 'Stopped.' });
  }

  const rows = fixture.controller.widgetRows(fixture.input.parentSessionId);

  expect(rows).toHaveLength(4);
  expect(rows.filter((row) => row.state === 'stopped')).toHaveLength(3);
  expect(rows.find((row) => row.taskId === launched.taskId)?.state).toBe('starting');

  recordEvent(launched.directory, launched.taskId, 'cleanup', {
    stopped: true,
    detail: 'Stopped.',
  });

  const refreshed = fixture.controller.widgetRows(fixture.input.parentSessionId);

  expect(refreshed.filter((row) => row.state === 'stopped')).toHaveLength(4);
});

it('saves and exposes a parent-provided short task label without changing the task text', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished);

  const launched = await fixture.controller.launch({
    ...fixture.input,
    label: 'Fix status counts',
  });

  const [row] = fixture.controller.widgetRows(fixture.input.parentSessionId);
  const saved = readTask(launched.directory);

  expect(row?.label).toBe('Fix status counts');
  expect(saved.label).toBe('Fix status counts');
  expect(saved.task).toBe(fixture.input.task);
});

it('shows the latest worker-reported phase without waking the parent', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);
  const notificationsAfterLaunch = fixture.notifications.length;
  const now = Date.now();

  writeWorkerActivity(launched.directory, {
    taskId: launched.taskId,
    sequence: 2,
    updatedAt: now,
    phase: 'active',
    label: 'tool: read',
    description: 'Fixing status counts',
    descriptionAt: now - 1000,
  });

  const [fresh] = fixture.controller.widgetRows(fixture.input.parentSessionId);

  expect(fresh?.activity).toBe('Fixing status counts');
  expect(fresh?.phaseDescription).toBe('Fixing status counts');
  expect(fresh?.phaseDescriptionAt).toBe(now - 1000);
  expect(fixture.notifications).toHaveLength(notificationsAfterLaunch);

  writeWorkerActivity(launched.directory, {
    taskId: launched.taskId,
    sequence: 3,
    updatedAt: now - 90_000,
    phase: 'active',
    label: 'tool: read',
    description: 'Fixing status counts',
    descriptionAt: now - 90_000,
  });

  const [stale] = fixture.controller.widgetRows(fixture.input.parentSessionId);

  expect(stale?.activity).toContain('Fixing status counts');
  expect(stale?.activity).toContain('stale');
  expect(fixture.notifications).toHaveLength(notificationsAfterLaunch);
});

it('does not present a retained phase as current work after the worker stops', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);

  writeWorkerActivity(launched.directory, {
    taskId: launched.taskId,
    sequence: 2,
    updatedAt: Date.now(),
    phase: 'active',
    label: 'tool: read',
    description: 'Running focused tests',
    descriptionAt: Date.now(),
  });

  records.acceptReport(launched.directory, launched.taskId, {
    taskId: launched.taskId,
    outcome: 'success',
    summary: 'Finished.',
    evidence: [],
  });

  recordEvent(launched.directory, launched.taskId, 'cleanup', {
    detail: 'Parent confirmed.',
    stopped: true,
  });

  const [stopped] = fixture.controller.widgetRows(fixture.input.parentSessionId);

  expect(stopped?.state).toBe('stopped');
  expect(stopped?.activity).not.toBe('Running focused tests');
  expect(stopped?.phaseDescription).toBe('Running focused tests');
});

it('keeps historical tasks without saved names in the worker history', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);
  const task = records.readTask(launched.directory);

  delete task.name;
  writeFileSync(join(launched.directory, 'task.json'), JSON.stringify(task));

  const [row] = fixture.controller.widgetRows(fixture.input.parentSessionId);

  const roleName = task.loadout.role === 'editing' ? 'worker' : 'scout';

  expect(row?.taskId).toBe(launched.taskId);
  expect(row?.name).toBe(`${roleName}-${launched.taskId.slice(0, 6)}`);
});

it('keeps cleanup failure unconfirmed even when its detail omits that wording', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);

  recordEvent(launched.directory, launched.taskId, 'cleanup', {
    detail: 'Transport failed. Check pane worker manually.',
    stopped: false,
  });

  const failedRow = fixture.controller.widgetRows(fixture.input.parentSessionId)[0];
  expect(failedRow?.state).toBe('cleanupUnconfirmed');
  expect(failedRow?.cleanupConfirmed).toBe(false);
  expect(failedRow?.details).toBe('Pi trusted tools + verified safety');
  expect(failedRow?.recovery).toContain('manual cleanup');
});

it('renames the owned worker pane with its name and model', async ({ onTestFinished }) => {
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'rename') {
      return JSON.stringify({ result: { pane: {} } });
    }

    return '';
  });

  await controller.launch(input);

  const rename = calls.find((call) => call[1] === 'rename');

  expect(rename?.slice(0, 3)).toEqual(['pane', 'rename', 'worker-1']);
  expect(rename?.[3]).toMatch(/^worker-[a-z0-9]{2} \(test\)$/);
});

it('titles the worker pane with the model ID after the provider', async ({ onTestFinished }) => {
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'rename') {
      return JSON.stringify({ result: { pane: {} } });
    }

    return '';
  });

  const loadout = { ...input.loadout, model: 'openrouter/meta/llama' };
  const launched = await controller.launch({ ...input, loadout });
  const rename = calls.find((call) => call[1] === 'rename');

  expect(rename?.[3]).toMatch(/^worker-[a-z0-9]{2} \(meta-llama\)$/);

  expect(workerArguments(readTask(launched.directory), []).slice(3, 7)).toEqual([
    '--provider',
    'openrouter',
    '--model',
    'meta/llama',
  ]);
});

it('keeps a worker running when the pane display title write is rejected', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'rename') {
      throw new Error('rename unsupported');
    }

    return '';
  });

  const launched = await controller.launch(input);

  expect(calls.some((call) => call[1] === 'rename')).toBe(true);
  expect(launched.state).not.toBe('cleanupUnconfirmed');
  expect(launched.state).not.toBe('notOwned');
});

const installedPackages = (sources: string[]) => ({
  extensions: sources.map((path) => ({
    path,
    enabled: true,
    metadata: { source: path, scope: 'temporary' as const, origin: 'package' as const },
  })),
  skills: [],
  prompts: [],
  themes: [],
});

const packageSettings = (configured: string[]) => {
  const installs: string[][] = [];

  const manager = (): WorkerPackageManager => ({
    listConfiguredPackages: () =>
      configured.map((source) => ({ source, scope: 'user' as const, filtered: false })),
    resolveExtensionSources: (sources) => {
      installs.push(sources);

      if (sources.includes('npm:broken')) {
        return Promise.reject(new Error('npm install failed'));
      }

      return Promise.resolve(installedPackages(sources));
    },
  });

  return { configured, installs, manager };
};

const launchedCommand = (calls: string[][]): string[] => {
  const launches = calls.filter((call) => call[0] === 'layout');
  const { root } = JSON.parse(launches.at(-1)?.[2] ?? '') as { root: { command: string[] } };

  return root.command;
};

it('loads profile packages with -e after the worker guards, skipping those settings load', async ({
  onTestFinished,
}) => {
  const settings = packageSettings(['npm:pi-agent-browser-native']);
  const { controller, input, calls } = setup(onTestFinished, 0, undefined, settings.manager);
  const packages = ['npm:pi-agent-browser-native@0.8.2', 'npm:pi-codex-image-gen'];
  const launched = await controller.launch({ ...input, loadout: { ...input.loadout, packages } });
  const command = launchedCommand(calls);

  expect(launched.failure).toBeUndefined();
  expect(command.at(-3)).toMatch(/workerExtension\.ts$/);
  expect(command.slice(-2)).toEqual(['-e', 'npm:pi-codex-image-gen']);
  expect(settings.installs).toEqual([['npm:pi-codex-image-gen']]);
  expect(readTask(launched.directory).loadout.packages).toEqual(packages);
});

it('refuses a launch whose profile package fails to install before it opens a pane', async ({
  onTestFinished,
}) => {
  const settings = packageSettings([]);

  const { controller, input, calls, directory } = setup(
    onTestFinished,
    0,
    undefined,
    settings.manager,
  );

  const saved = readdirSync(directory);
  const loadout = { ...input.loadout, packages: ['npm:broken', 'npm:later'] };

  await expect(controller.launch({ ...input, loadout })).rejects.toThrow(
    'Worker profile package npm:broken failed to install',
  );

  expect(settings.installs).toEqual([['npm:broken']]);
  expect(calls.filter((call) => call[0] === 'layout')).toEqual([]);
  expect(readdirSync(directory)).toEqual(saved);
});

it('names the -e packages when the worker exits before readiness', async ({ onTestFinished }) => {
  let inspections = 0;
  const settings = packageSettings(['npm:pi-agent-browser-native']);

  const fixture = setup(
    onTestFinished,
    -1,
    async (argumentsList) => {
      // Pi exits at startup, and herdr removes its pane.
      if (argumentsList[1] === 'process-info' && ++inspections > 1) {
        fixture.fake.state.stopped = true;
      }

      return '';
    },
    settings.manager,
  );

  const packages = ['npm:pi-agent-browser-native', 'npm:pi-codex-image-gen'];
  const loadout = { ...fixture.input.loadout, packages };
  const status = await fixture.controller.launch({ ...fixture.input, loadout });

  expect(status).toMatchObject({ outcome: 'failure', state: 'stopped' });
  expect(status.failure).toContain('exited before readiness');
  expect(status.failure).toContain('pi -e <source>');
  expect(status.failure).toContain('npm:pi-codex-image-gen');
  expect(status.failure).not.toContain('npm:pi-agent-browser-native');
});

it('decides the -e packages again when a follow-up starts after settings change', async () => {
  const settings = packageSettings([]);
  const packages = ['npm:pi-agent-browser-native'];
  const fixture = await completed(undefined, { manager: settings.manager, sources: packages });

  expect(launchedCommand(fixture.calls).slice(-2)).toEqual(['-e', 'npm:pi-agent-browser-native']);

  settings.configured.push('npm:pi-agent-browser-native');
  fixture.calls.length = 0;
  const next = await fixture.controller.followUp(fixture.input, fixture.context);
  const listings = fixture.calls.filter((call) => call[0] === 'agent' && call[1] === 'list');

  expect(next.failure).toBeUndefined();
  // Without an install, nothing waited, so the first listing still holds.
  expect(listings).toHaveLength(1);
  expect(launchedCommand(fixture.calls).at(-1)).toMatch(/workerExtension\.ts$/);
  expect(readTask(next.directory).loadout.packages).toEqual(packages);
});

it('stops waiting for a pending package install when the launch is cancelled', async ({
  onTestFinished,
}) => {
  const installing = Promise.withResolvers<undefined>();

  const manager = (): WorkerPackageManager => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: () => {
      installing.resolve(undefined);

      // A stalled npm install.
      return new Promise(() => undefined);
    },
  });

  const { controller, input, calls, directory } = setup(onTestFinished, 0, undefined, manager);
  const saved = readdirSync(directory);
  const cancel = new AbortController();
  const loadout = { ...input.loadout, packages: ['npm:slow'] };
  const launch = controller.launch({ ...input, loadout }, cancel.signal);

  await installing.promise;
  cancel.abort();

  await expect(launch).rejects.toThrow('Worker profile package npm:slow install was cancelled.');
  expect(calls.filter((call) => call[0] === 'layout')).toEqual([]);
  expect(readdirSync(directory)).toEqual(saved);
});

it('refuses a launch at capacity before it installs profile packages', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_SUBAGENT_CAP', '1');
  const settings = packageSettings([]);
  const { controller, input } = setup(onTestFinished, 0, undefined, settings.manager);

  await controller.launch(input);
  const loadout = { ...input.loadout, packages: ['npm:pi-codex-image-gen'] };

  await expect(controller.launch({ ...input, loadout })).rejects.toThrow('Worker capacity full');
  expect(settings.installs).toEqual([]);
});

it('refuses a launch whose slot another launch took during its package install', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_SUBAGENT_CAP', '1');
  const installing = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();

  const manager = (): WorkerPackageManager => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: async (sources) => {
      installing.resolve(undefined);
      await release.promise;

      return installedPackages(sources);
    },
  });

  const { controller, input, directory } = setup(onTestFinished, 0, undefined, manager);
  const loadout = { ...input.loadout, packages: ['npm:slow'] };
  const waiting = controller.launch({ ...input, loadout });

  await installing.promise;
  const taken = await controller.launch(input);
  const saved = readdirSync(directory);

  release.resolve(undefined);

  await expect(waiting).rejects.toThrow('Worker capacity full');
  expect(taken.failure).toBeUndefined();
  expect(readdirSync(directory)).toEqual(saved);
});

const stalledInstall = (): WorkerPackageManager => ({
  listConfiguredPackages: () => [],
  resolveExtensionSources: () => new Promise(() => undefined),
});

it('names the package whose install outlasts the launch budget', async ({ onTestFinished }) => {
  const { controller, input, directory } = setup(onTestFinished, 0, undefined, stalledInstall);
  const saved = readdirSync(directory);
  const loadout = { ...input.loadout, packages: ['npm:slow'] };

  // AbortSignal.timeout ignores fake timers, so this test waits in real time.
  await expect(controller.launch({ ...input, loadout, timeout: 200 })).rejects.toThrow(
    'Worker profile package npm:slow install ran out of launch time.',
  );

  expect(readdirSync(directory)).toEqual(saved);
});

it('refuses a follow-up whose native session gained a live writer during its install', async () => {
  let live: unknown[] = [];
  let following = false;

  const manager = (): WorkerPackageManager => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: (sources) => {
      // The user resumes the saved session by hand while npm runs.
      if (following) {
        live = [
          {
            pane_id: 'manual',
            name: 'manual-pi',
            agent_session: { kind: 'path', value: fixture.source.nativeSessionFile },
          },
        ];
      }

      return Promise.resolve(installedPackages(sources));
    },
  });

  const fixture = await completed(
    async (argumentsList) =>
      argumentsList[0] === 'agent' && argumentsList[1] === 'list'
        ? JSON.stringify({ result: { type: 'agent_list', agents: live } })
        : '',
    { manager, sources: ['npm:pi-agent-browser-native'] },
  );

  const saved = savedFiles(fixture.directory);
  fixture.calls.length = 0;
  following = true;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'already live',
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);

  expect(fixture.calls).toEqual([
    ['agent', 'list'],
    ['agent', 'list'],
  ]);
});

it('never runs two profile package installs at once across parallel launches', async ({
  onTestFinished,
}) => {
  const started: string[] = [];
  const firstStarted = Promise.withResolvers<undefined>();
  let queued = 0;

  const manager = (): WorkerPackageManager => ({
    // Each launch reads settings right before it joins the install queue.
    listConfiguredPackages: () => {
      queued += 1;

      return [];
    },
    resolveExtensionSources: (sources) => {
      started.push(...sources);
      firstStarted.resolve(undefined);

      // A stalled npm install.
      return new Promise(() => undefined);
    },
  });

  const { controller, input, directory } = setup(onTestFinished, 0, undefined, manager);
  const saved = readdirSync(directory);
  const cancelFirst = new AbortController();
  const cancelSecond = new AbortController();

  const launch = (source: string, cancel: AbortController) =>
    controller.launch(
      { ...input, loadout: { ...input.loadout, packages: [source] } },
      cancel.signal,
    );

  const first = launch('npm:first', cancelFirst);
  const second = launch('npm:second', cancelSecond);

  await firstStarted.promise;

  await vi.waitFor(() => {
    expect(queued).toBe(2);
  });

  // Run every pending step of the second launch while the first install still runs.
  await new Promise((resolve) => setImmediate(resolve));
  expect(started).toEqual(['npm:first']);

  cancelSecond.abort();
  await expect(second).rejects.toThrow('npm:second install was cancelled');
  cancelFirst.abort();
  await expect(first).rejects.toThrow('npm:first install was cancelled');
  expect(started).toEqual(['npm:first']);
  expect(readdirSync(directory)).toEqual(saved);
});
