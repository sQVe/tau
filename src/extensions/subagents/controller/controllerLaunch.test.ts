import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, it, vi, onTestFinished as afterTest } from 'vitest';

import { acceptReport, readTask, recordEvent } from '../records.js';
import { WorkerController } from './controller.js';
import { setup } from './fixtures/controllerFixture.js';
import { RequestNotSentError, workerArguments } from './inspect.js';
import { EvidenceUnavailableError } from './record.js';

vi.mock(import('node:fs'), { spy: true });

it('saves acceptance criteria and reports them in the status', async ({ onTestFinished }) => {
  const fixture = setup(onTestFinished);
  const acceptance = ['First.', 'Second.'];

  const launched = await fixture.controller.launch({ ...fixture.input, acceptance });

  expect(readTask(launched.directory).acceptance).toEqual(acceptance);
  expect(fixture.controller.status(launched.taskId, 'parent-id').acceptance).toEqual(acceptance);
});

it('launches an empty acceptance list as a task without criteria', async ({ onTestFinished }) => {
  const fixture = setup(onTestFinished);

  const launched = await fixture.controller.launch({ ...fixture.input, acceptance: [] });

  expect(readTask(launched.directory).acceptance).toBeUndefined();
});

it('saves a launched Pi task in the current record format', async ({ onTestFinished }) => {
  const fixture = setup(onTestFinished);

  const launched = await fixture.controller.launch(fixture.input);

  expect(JSON.parse(readFileSync(join(launched.directory, 'task.json'), 'utf8'))).toMatchObject({
    version: 11,
  });
});

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
    loadout: { ...task.loadout, tools: ['read'], skills: ['/skills/tracker/SKILL.md'] },
  };

  expect(workerArguments(narrowed, []).slice(9, 14)).toEqual([
    '--tools',
    'read,subagent_progress,subagent_report,subagent_question,tracker_evidence,tracker_draft,draft_review',
    '--no-skills',
    '--skill',
    '/skills/tracker/SKILL.md',
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
