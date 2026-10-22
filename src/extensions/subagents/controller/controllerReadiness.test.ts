import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi, onTestFinished as afterTest } from 'vitest';

import * as cancellationModule from '../cancellation.js';
import { acceptReport, readEvent, readTask, recordEvent, TaskFormatError } from '../records.js';
import * as records from '../records.js';
import { recordStartupFailure } from '../startupFailure.js';
import { renderStartupFailure } from '../startupFailureDecision.js';
import type { StartupFailureOutcome } from '../startupFailureDecision.js';
import { WorkerController } from './controller.js';
import { captureError, setup } from './fixtures/controllerFixture.js';
import { EvidenceUnavailableError } from './record.js';

vi.mock(import('node:fs'), { spy: true });

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
      fixture.fake.replaceProcess(fixture.fake.workers()[0]!.terminalId);
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
      fixture.fake.exit(fixture.fake.workers()[0]!.terminalId);

      throw new Error('Command failed: herdr pane process-info');
    }

    return '';
  });

  const status = await fixture.controller.launch(fixture.input);

  expect(status).toMatchObject({ outcome: 'failure', state: 'stopped' });
  expect(status.failure).toContain('exited before readiness');
});

const launchWithWorkerFailure = async (
  onTestFinished: Parameters<typeof setup>[0],
  record: (taskDirectory: string) => void,
) => {
  let inspections = 0;

  const fixture = setup(onTestFinished, -1, async (argumentsList) => {
    if (argumentsList[1] === 'process-info' && ++inspections > 1) {
      const layout = fixture.calls.find((call) => call[0] === 'layout');
      const { root } = JSON.parse(layout?.[2] ?? '') as { root: { env: Record<string, string> } };

      record(root.env.TAU_WORKER_RECORD ?? '');
      fixture.fake.exit(fixture.fake.workers()[0]!.terminalId);
    }

    return '';
  });

  return fixture.controller.launch(fixture.input);
};

const noOutcome: StartupFailureOutcome = { notice: undefined, workerError: undefined };

it('adds the recorded worker error to the startup failure detail', async ({ onTestFinished }) => {
  const status = await launchWithWorkerFailure(onTestFinished, (taskDirectory) => {
    recordStartupFailure(taskDirectory, new Error('Saved model changed.'));
  });

  expect(status.failure).toContain('exited before readiness');
  expect(status.failure).toContain('Saved model changed.');
  expect(status.failure).not.toContain(renderStartupFailure({ ...noOutcome, notice: 'restart' }));
});

it('tells the manager to restart when the worker refused a retired task', async ({
  onTestFinished,
}) => {
  const status = await launchWithWorkerFailure(onTestFinished, (taskDirectory) => {
    const retired = new Error('Saved task is unreadable', {
      cause: new TaskFormatError('retired', 'retired format'),
    });

    recordStartupFailure(taskDirectory, retired);
  });

  expect(status.failure).toContain('exited before readiness');

  expect(status.failure).toContain(
    renderStartupFailure({ notice: 'restart', workerError: undefined }),
  );
});

it.each([
  { fixture: 'newer', notice: 'newerRecord' as const },
  { fixture: 'malformed', notice: 'unreadableRecord' as const },
])(
  'keeps the original startup error and notes a $fixture worker record',
  async ({ fixture, notice }) => {
    const saved = readFileSync(
      new URL(`../fixtures/startupErrors/${fixture}.json`, import.meta.url),
      'utf8',
    );

    const status = await launchWithWorkerFailure(afterTest, (taskDirectory) => {
      writeFileSync(join(taskDirectory, 'startupError.json'), saved);
    });

    expect(status.failure).toContain('exited before readiness');
    expect(status.failure).toContain(renderStartupFailure({ notice, workerError: undefined }));
    expect(status.failure).not.toContain(renderStartupFailure({ ...noOutcome, workerError: '' }));
  },
);

it('adds nothing to the startup error when the worker saved no record', async ({
  onTestFinished,
}) => {
  const status = await launchWithWorkerFailure(onTestFinished, () => undefined);

  expect(status.failure).toContain('exited before readiness');
  expect(status.failure).not.toContain(renderStartupFailure({ ...noOutcome, workerError: '' }));

  for (const notice of ['restart', 'newerRecord', 'unreadableRecord'] as const) {
    expect(status.failure).not.toContain(renderStartupFailure({ ...noOutcome, notice }));
  }
});

it('detects an owned worker exiting before readiness without waiting for the task deadline', async ({
  onTestFinished,
}) => {
  let inspections = 0;

  const fixture = setup(onTestFinished, -1, async (argumentsList) => {
    // Herdr removes the pane when its worker exits.
    if (argumentsList[1] === 'process-info' && ++inspections > 1) {
      fixture.fake.exit(fixture.fake.workers()[0]!.terminalId);
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

    fake.exit(fake.workers()[0]!.terminalId);

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
