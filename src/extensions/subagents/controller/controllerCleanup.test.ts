import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, it, vi, onTestFinished as afterTest } from 'vitest';

import * as terminalModule from '../../../terminal.js';
import { readEvent, readTask, recordEvent } from '../records.js';
import { captureError, setup } from './fixtures/controllerFixture.js';
import { EvidenceUnavailableError } from './record.js';

vi.mock(import('node:fs'), { spy: true });

it.each(['confirmed', 'unconfirmed', 'confirmed with failing notices'] as const)(
  'keeps terminal ownership during %s cleanup and releases it afterward',
  async (outcome) => {
    const tokens = new Map<string, string>();
    const entered = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    let cleaning = false;
    let held = false;

    const workerProcessId = (paneId: string) =>
      harness.fake.workers().find((worker) => worker.paneId === paneId)?.processId ?? 0;

    const harness = setup(afterTest, 0, async (argumentsList, budget, signal) => {
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
        const response = await harness.fake.client(argumentsList, budget, signal);

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
          processId: workerProcessId(created),
        });

        return response;
      }

      if (argumentsList[1] === 'process-info') {
        return JSON.stringify({
          result: {
            process_info: {
              pane_id: paneId,
              shell_pid: workerProcessId(paneId),
              foreground_process_group_id: workerProcessId(paneId),
              foreground_processes: [
                { pid: workerProcessId(paneId), argv: ['pi', tokens.get(paneId)] },
              ],
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

      return harness.fake.client(argumentsList, budget, signal);
    });

    const { controller, input, notifications } = harness;
    const terminal = harness.fake.layout;

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
        const processId = scenario === 'replacement process' ? 100 : fake.workers()[0]!.processId;

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
        fake.exit(fake.workers()[0]!.terminalId);

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
  const { controller, input } = setup(onTestFinished, 0, undefined, undefined, 1);
  const first = await controller.launch(input);

  await controller.cancel(first.taskId, 'parent-id');
  await controller.cancel(first.taskId, 'parent-id');
  const next = await controller.launch(input);

  expect(controller.owns(next.taskId)).toBe(true);
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

      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }

    return client(argumentsList, budget, signal);
  });

  const launching = fixture.controller.launch(fixture.input);
  await enteredStart.promise;
  const shutdown = fixture.controller.stopAll('reload');
  await vi.advanceTimersByTimeAsync(100);
  await shutdown;
  const launched = await launching;

  expect(fixture.fake.workers()[0]?.exited).toBe(true);
  expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(true);
  expect(fixture.fake.layout.panes.map((pane) => pane.pane_id)).toEqual(['parent']);
});

it('stops running workers and frees their slots on reload', async ({ onTestFinished }) => {
  const fixture = setup(onTestFinished);

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
