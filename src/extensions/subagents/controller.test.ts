import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { WorkerController, taskStatus, workerArguments } from './controller.js';
import type { HerdrClient } from './controller.js';
import { acceptReport, readTask, recordEvent } from './records.js';
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
      if (readyDelay) {
        setTimeout(ready, readyDelay);
      } else {
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
  expect(workerArguments(task)).not.toContain('--no-extensions');
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
