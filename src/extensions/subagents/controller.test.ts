import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it, vi, onTestFinished as afterTest } from 'vitest';

import * as cancellationModule from './cancellation.js';
import { WorkerController, taskStatus, workerArguments } from './controller.js';
import type { HerdrClient } from './controller.js';
import { acceptReport, readTask, recordEvent } from './records.js';
import * as records from './records.js';
import type { Loadout } from './types.js';

export const fixtureLoadout = (directory: string): Loadout => {
  return {
    profile: 'worker',
    role: 'editing',
    model: 'faux/test',
    modelFingerprint: '0'.repeat(64),
    providerFingerprint: '0'.repeat(64),
    thinking: 'off',
    cwd: directory,
    agentDirectory: directory,
    permissions: 'trusted-full-tools',
    tools: ['read', 'bash', 'edit', 'write', 'subagent_report'],
    noExtensions: false,
    integrations: [join(directory, 'safety.js')],
    integrationFingerprint: '0'.repeat(64),
    safetyExtension: join(directory, 'safety.js'),
    instructions: 'Work on the assigned task.',
  };
};

const setup = (
  onTestFinished: (callback: () => void) => void,
  readyDelay = 0,
  intercept?: HerdrClient,
) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-controller-'));
  onTestFinished(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  let token = '';
  const calls: string[][] = [];
  const client: HerdrClient = async (arguments_, budget, signal) => {
    calls.push(arguments_);
    if (intercept) {
      const response = await intercept(arguments_, budget, signal);
      if (response) {
        return response;
      }
    }
    if (arguments_[1] === 'split') {
      return JSON.stringify({ result: { pane: { pane_id: 'owned-pane' } } });
    }
    if (arguments_[1] === 'start') {
      token = arguments_[arguments_.indexOf('--session') + 1] ?? '';
      const task = readTask(dirname(token));
      const ready = () => {
        recordEvent(dirname(token), task.taskId, 'ready', 'Ready.', false, process.pid);
      };
      if (readyDelay > 0) {
        setTimeout(ready, readyDelay);
      } else if (readyDelay === 0) {
        ready();
      }

      return JSON.stringify({ result: {} });
    }
    if (arguments_[1] === 'process-info') {
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: 'owned-pane',
            shell_pid: 100,
            foreground_process_group_id: process.pid,
            foreground_processes: [{ pid: process.pid, argv: ['pi', token] }],
          },
        },
      });
    }
    if (arguments_[1] === 'get') {
      return JSON.stringify({
        result: { agent: { pane_id: 'owned-pane', agent: 'pi', agent_session: { value: token } } },
      });
    }
    throw new Error('Injected herdr failure; active process remains alive.');
  };
  const notifications: string[] = [];
  const controller = new WorkerController(directory, client, (message) =>
    notifications.push(message),
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
    parentPane: 'parent-pane',
  };

  return { directory, controller, calls, notifications, input };
};

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
  const directories = readdirSync(directory);
  expect(directories).toHaveLength(1);
  expect(directories.map((name) => readdirSync(join(directory, name)))).toEqual([[]]);
});

it('launches a fresh worker with saved full-tool settings and recovers without resubmission', async ({
  onTestFinished,
}) => {
  const { directory, controller, calls, input } = setup(onTestFinished);
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
  expect(workerArguments(task).slice(3, 9)).toEqual([
    '--provider',
    'faux',
    '--model',
    'test',
    '--thinking',
    'off',
  ]);
  expect(workerArguments(task)).toContain('--no-extensions');
  expect(workerArguments(task)).toContain(input.loadout.safetyExtension);
  expect(launched.accepted).toBe(false);
  recordEvent(launched.directory, task.taskId, 'accepted', 'Accepted.');
  acceptReport(launched.directory, task.taskId, {
    taskId: task.taskId,
    outcome: 'success',
    summary: 'Edited fixture.',
    evidence: ['test passed'],
  });

  expect(controller.status(task.taskId, 'parent-id')).toMatchObject({
    accepted: true,
    reportAccepted: true,
    stopped: false,
    outcome: 'success',
    deadline: task.deadline,
  });
  expect(calls.filter((call) => call[1] === 'start')).toHaveLength(1);
  expect(calls.find((call) => call[1] === 'start')?.[2]).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  controller.close();
  const recovered = new WorkerController(directory);
  onTestFinished(() => {
    recovered.close();
  });
  expect(recovered.status(task.taskId, 'parent-id').enforcement).toContain('Saved evidence only');
  expect(recovered.status(task.taskId, 'parent-id').report?.summary).toBe('Edited fixture.');
  expect(() => recovered.status(task.taskId, 'wrong-parent')).toThrow('another parent');
  await expect(recovered.cancel(task.taskId, 'parent-id')).rejects.toThrow('manual cleanup');
});

it('recovers version 1 reports and native references without extension discovery metadata', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const task = readTask(launched.directory);
  const { noExtensions: _metadata, ...legacyLoadout } = task.loadout;
  writeFileSync(
    join(launched.directory, 'task.json'),
    JSON.stringify({ ...task, loadout: legacyLoadout }),
  );
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
    reportAccepted: true,
    nativeSessionId: task.nativeSessionId,
    nativeSessionFile: task.nativeSessionFile,
    report: { summary: 'Saved HEAD handover.' },
  });
  expect(workerArguments(readTask(launched.directory))).toContain('--no-extensions');
  expect(workerArguments(readTask(launched.directory))).toContain(task.loadout.safetyExtension);
});

it('stops dispatched work when the launch status finds corrupt report evidence', async ({
  onTestFinished,
}) => {
  let recordDirectory = '';
  const { controller, input, calls, notifications } = setup(
    onTestFinished,
    0,
    async (arguments_) => {
      if (arguments_[1] === 'start') {
        recordDirectory = dirname(arguments_[arguments_.indexOf('--session') + 1] ?? '');
        writeFileSync(join(recordDirectory, 'report.json'), '{');
      }
      return '';
    },
  );

  await expect(controller.launch(input)).rejects.toThrow('saved evidence is unavailable');
  expect(readdirSync(recordDirectory)).toContain('dispatch.json');
  await vi.waitFor(() => {
    expect(notifications).toHaveLength(1);
  });
  expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
  expect(notifications[0]).toContain('owned-pane');
  expect(readFileSync(join(recordDirectory, 'report.json'), 'utf8')).toBe('{');
});

it('only lets the owning parent stop work after a status evidence failure', async ({
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
  expect(() => controller.status(launched.taskId, 'parent-id')).toThrow(launched.nativeSessionFile);
  await vi.waitFor(() => {
    expect(notifications).toHaveLength(1);
  });
  expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
  expect(notifications[0]).toContain(launched.nativeSessionId);
});

it('keeps the original deadline and reports active-work cancellation failure honestly', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const { controller, calls, input, notifications } = setup(onTestFinished);
  const launched = await controller.launch(input);
  await vi.advanceTimersByTimeAsync(5000);
  expect(controller.status(launched.taskId, 'parent-id').deadline).toBe(launched.deadline);
  vi.setSystemTime(Date.now() - 60_000);
  await vi.advanceTimersByTimeAsync(2600);
  await controller.cancel(launched.taskId, 'parent-id');
  const status = controller.status(launched.taskId, 'parent-id');

  expect(status.outcome).toBe('timeout');
  expect(status.stopped).toBe(false);
  expect(status.cleanup).toContain('manual cleanup');
  expect(status.enforcement).not.toContain('remains active');
  expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
  expect(calls.some((call) => call[1] === 'close')).toBe(false);
  expect(notifications).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(notifications).toHaveLength(1);
});

it('preserves incomplete output and malformed evidence without retrying startup', async ({
  onTestFinished,
}) => {
  const { directory, input } = setup(onTestFinished);
  const calls: string[][] = [];
  const controller = new WorkerController(directory, async (arguments_) => {
    calls.push(arguments_);
    throw new Error('Startup unavailable');
  });
  onTestFinished(() => {
    controller.close();
  });
  const status = await controller.launch(input);

  expect(status).toMatchObject({
    outcome: 'failure',
    accepted: false,
    reportAccepted: false,
    stopped: false,
  });
  expect(calls).toHaveLength(1);
  expect(readdirSync(status.directory)).toContain('task.json');
  writeFileSync(join(status.directory, 'report.json'), '{');
  expect(() => taskStatus(status.directory)).toThrow(/JSON|property/);
});

it('distinguishes settled missing handover and cancellation from success', async ({
  onTestFinished,
}) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);
  recordEvent(launched.directory, launched.taskId, 'settled', 'Stopped without report.', true);

  expect(taskStatus(launched.directory)).toMatchObject({
    outcome: 'incomplete',
    reportAccepted: false,
    stopped: true,
  });
  const cancelled = await controller.cancel(launched.taskId, 'parent-id');
  expect(cancelled.outcome).toBe('cancelled');
});

it('includes prior loadout resolution in the original task deadline', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const { controller, input } = setup(onTestFinished);
  const startedAt = { wall: Date.now() - 4000, monotonic: performance.now() - 4000 };
  const launched = await controller.launch({ ...input, startedAt });

  expect(launched.deadline).toBe(startedAt.wall + input.timeout);
  await vi.advanceTimersByTimeAsync(3600);
  await controller.cancel(launched.taskId, 'parent-id');
  expect(controller.status(launched.taskId, 'parent-id').outcome).toBe('timeout');
});

it('ends enforcement on parent shutdown without claiming cleanup', async ({ onTestFinished }) => {
  vi.useFakeTimers();
  const { controller, calls, input, notifications } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const callCount = calls.length;

  controller.close();
  await vi.advanceTimersByTimeAsync(20_000);

  expect(controller.status(launched.taskId, 'parent-id')).toMatchObject({
    outcome: 'incomplete',
    stopped: false,
    deadlineActive: false,
  });
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
  expect(readdirSync(launched.directory)).not.toContain('notified.json');
  expect(controller.status(launched.taskId, 'parent-id')).toMatchObject({
    outcome: 'cancelled',
    stopped: false,
    deadlineActive: false,
  });
  expect(controller.status(launched.taskId, 'parent-id').cleanup).toContain('manually');
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

it('detects an owned worker exiting before readiness without waiting for the task deadline', async ({
  onTestFinished,
}) => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
  });
  let inspections = 0;
  const { controller, input, calls } = setup(onTestFinished, -1, async (arguments_) => {
    if (arguments_[1] === 'process-info' && ++inspections > 1) {
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: 'owned-pane',
            shell_pid: 100,
            foreground_process_group_id: 100,
            foreground_processes: [{ pid: 100, argv: ['sh'] }],
          },
        },
      });
    }
    return arguments_[1] === 'close' ? '{}' : '';
  });
  const started = performance.now();
  const status = await controller.launch({ ...input, timeout: 60_000 });

  expect(performance.now() - started).toBeLessThan(1500);
  expect(status).toMatchObject({ outcome: 'failure', ready: false, stopped: true });
  expect(status.failure).toContain('exited before readiness');
  expect(calls.filter((call) => call[1] === 'start')).toHaveLength(1);
  expect(calls.some((call) => call[1] === 'send-keys')).toBe(false);
});

it.each(['missing report', 'accepted report'])(
  'detects post-readiness exit with %s before the deadline',
  async (reportState) => {
    vi.useFakeTimers();
    let exited = false;
    const { controller, input, calls, notifications } = setup(afterTest, 0, async (arguments_) => {
      if (exited && arguments_[1] === 'process-info') {
        return JSON.stringify({
          result: {
            process_info: {
              pane_id: 'owned-pane',
              shell_pid: 100,
              foreground_process_group_id: 100,
            },
          },
        });
      }

      return arguments_[1] === 'close' ? '{}' : '';
    });
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
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    });
    exited = true;

    await vi.advanceTimersByTimeAsync(250);

    expect(controller.status(launched.taskId, 'parent-id')).toMatchObject({
      outcome: reportState === 'accepted report' ? 'success' : 'incomplete',
      deadlineActive: false,
      stopped: true,
      report: reportState === 'accepted report' ? report : undefined,
    });
    expect(notifications).toHaveLength(1);
    expect(calls.filter((call) => call[1] === 'start')).toHaveLength(1);
    expect(calls.filter((call) => call[1] === 'close')).toHaveLength(1);
    expect(calls.some((call) => call[1] === 'send-keys')).toBe(false);
  },
);

it('cleans up an owned live pane even when startup failure evidence is corrupt', async ({
  onTestFinished,
}) => {
  let recordDirectory = '';
  const { controller, input, calls, notifications } = setup(
    onTestFinished,
    0,
    async (arguments_) => {
      if (arguments_[1] === 'start') {
        recordDirectory = dirname(arguments_[arguments_.indexOf('--session') + 1] ?? '');
        writeFileSync(join(recordDirectory, 'startupFailure.json'), '{');
      }
      return '';
    },
  );

  const launch = controller.launch(input);
  await expect(launch).rejects.toThrow(/records|evidence/i);
  const task = readTask(recordDirectory);
  await expect(launch).rejects.toThrow(task.nativeSessionFile);
  expect(notifications.join('\n')).toContain(task.nativeSessionId);
  expect(notifications.join('\n')).toContain(task.nativeSessionFile);
  expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
  expect(calls.some((call) => call[1] === 'close')).toBe(false);
  expect(readFileSync(join(recordDirectory, 'startupFailure.json'), 'utf8')).toBe('{');
  expect(notifications.join('\n')).toContain('owned-pane');
  expect(notifications.join('\n')).toMatch(/records|evidence/i);
});

it('reports both startup and receipt failures after attempting owned pane cleanup', async ({
  onTestFinished,
}) => {
  let inspections = 0;
  const { controller, input, calls, notifications } = setup(
    onTestFinished,
    -1,
    async (arguments_) => {
      if (arguments_[1] === 'process-info' && ++inspections === 2) {
        throw new Error('Injected worker identity probe failure');
      }
      return '';
    },
  );
  const original = records.recordEvent;
  vi.spyOn(records, 'recordEvent').mockImplementation((...arguments_) => {
    if (arguments_[2] === 'startupFailure') {
      throw new Error('Injected startup receipt write failure');
    }
    original(...arguments_);
  });
  const launch = controller.launch(input);

  await expect(launch).rejects.toThrow('Injected startup receipt write failure');
  await expect(launch).rejects.toThrow('Injected worker identity probe failure');
  expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
  expect(notifications.join('\n')).toContain('Injected startup receipt write failure');
  expect(notifications.join('\n')).toContain('Injected worker identity probe failure');
  expect(notifications.join('\n')).toContain('owned-pane');
});

it.each(['cancelled', 'timeout'] as const)(
  'stops an owned live pane before reporting a failed %s receipt write',
  async (reason) => {
    vi.useFakeTimers();
    const { controller, input, calls, notifications } = setup(afterTest);
    const launched = await controller.launch(input);
    writeFileSync(join(launched.directory, 'report.json'), '{');
    const original = records.recordEvent;
    vi.spyOn(records, 'recordEvent').mockImplementation((...arguments_) => {
      if (arguments_[2] === reason) {
        throw new Error('Injected receipt write failure');
      }
      original(...arguments_);
    });

    if (reason === 'timeout') {
      await vi.advanceTimersByTimeAsync(7600);
    }
    await expect(controller.cancel(launched.taskId, 'parent-id')).rejects.toThrow(
      /records|evidence/i,
    );
    expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
    expect(calls.some((call) => call[1] === 'close')).toBe(false);
    expect(notifications.join('\n')).toContain('Injected receipt write failure');
    expect(notifications.join('\n')).toContain('owned-pane');
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
  await expect(cancelled).rejects.toThrow(launched.nativeSessionFile);
  expect(calls.filter((call) => call[1] === 'send-keys')).toHaveLength(1);
  expect(notifications.join('\n')).toContain('owned-pane');
  expect(readFileSync(join(launched.directory, 'task.json'), 'utf8')).toBe('{');
});

it('distinguishes missing readiness timeout from startup failure inside the original deadline', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const monitoring = Promise.withResolvers<undefined>();
  let inspections = 0;
  const { controller, input, calls } = setup(
    onTestFinished,
    -1,
    async (arguments_, budget, signal) => {
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(7500);
      if (arguments_[1] === 'process-info' && ++inspections === 2) {
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

  expect(status).toMatchObject({
    outcome: 'timeout',
    ready: false,
    stopped: false,
    failure: undefined,
  });
  expect(calls.filter((call) => call[1] === 'start')).toHaveLength(1);
  expect(readdirSync(status.directory)).not.toContain('dispatch.json');
});

it('polls slow worker readiness at 250 ms intervals', async ({ onTestFinished }) => {
  vi.spyOn(cancellationModule, 'runClient').mockResolvedValue('fixture start');
  const polled = Promise.withResolvers<undefined>();
  const inspections: number[] = [];
  const { controller, input } = setup(onTestFinished, -1, async (arguments_) => {
    if (arguments_[1] === 'process-info') {
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

it('reports recovered corrupt task evidence with its task directory and unknown native identity', async ({
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

  expect(() => recovered.status(launched.taskId, 'parent-id')).toThrow(launched.directory);
  expect(() => recovered.status(launched.taskId, 'parent-id')).toThrow(
    'Native session unavailable',
  );
  expect(() => recovered.status(launched.taskId, 'parent-id')).toThrow('manually');
});

it('waits for worker readiness after herdr readiness without a new startup budget', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const { controller, input, calls } = setup(onTestFinished, 100);
  const launch = controller.launch(input);
  await vi.advanceTimersByTimeAsync(150);
  const status = await launch;

  expect(status.failure).toBeUndefined();
  expect(status.ready).toBe(true);
  expect(status.outcome).toBe('running');
  expect(calls.filter((call) => call[1] === 'start')).toHaveLength(1);
});
