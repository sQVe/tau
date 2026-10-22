import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, it, vi, onTestFinished as afterTest } from 'vitest';

import { writeWorkerActivity } from '../activity.js';
import * as questions from '../questionRecords.js';
import { readEvent, readTask, recordEvent } from '../records.js';
import * as records from '../records.js';
import { renderWorkerWidget } from '../widget.js';
import { WorkerController } from './controller.js';
import { setup } from './fixtures/controllerFixture.js';
import { EvidenceUnavailableError, taskStatus } from './record.js';

vi.mock(import('node:fs'), { spy: true });

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

it('reads status and widget rows without writing records or stopping workers', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished);
  const launched = await controller.launch(input);

  const snapshot = () =>
    readdirSync(launched.directory)
      .toSorted()
      .map((name) => [name, readFileSync(join(launched.directory, name), 'utf8')]);

  const before = snapshot();
  const callCount = calls.length;

  controller.status(launched.taskId, 'parent-id');
  controller.widgetRows('parent-id');

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

  // Stopping the worker polls its pane on real timers.
  await vi.waitFor(() => {
    expect(readEvent(launched.directory, launched.taskId, 'timeout')).toBeDefined();
  });

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
    requestedModel: 'faux/test',
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
    cleanupConfirmed: true,
  });

  if (stoppedRow?.stoppedAt === undefined) {
    throw new Error('Confirmed cleanup must preserve its terminal timestamp.');
  }

  expect(stoppedRow.stoppedAt).toBeGreaterThan(0);
});

it.each([
  { observation: 'fresh', age: 0, label: 'other/observed' },
  { observation: 'stale', age: 60_001, label: 'requested faux/test' },
  { observation: 'missing', age: undefined, label: 'requested faux/test' },
])('renders models from a $observation observation', async ({ age, label }) => {
  const fixture = setup(afterTest);
  const launched = await fixture.controller.launch(fixture.input);
  const now = Date.now();

  if (age !== undefined) {
    writeWorkerActivity(launched.directory, {
      taskId: launched.taskId,
      sequence: 1,
      updatedAt: now - age,
      phase: 'active',
      label: 'tool: read',
      model: 'other/observed',
    });
  }

  const rows = fixture.controller.widgetRows(fixture.input.parentSessionId);
  const plainTheme = { fg: (_color: string, text: string) => text } as never;
  const widget = renderWorkerWidget(rows, 200, now, plainTheme).join('\n');

  expect(widget).toContain(label);

  if (age !== 0) {
    // eslint-disable-next-line vitest/no-conditional-expect -- Only stale and missing observations must hide the observed model.
    expect(widget).not.toContain('other/observed');
  }
});

it('refreshes current-session worker rows after cleanup', async ({ onTestFinished }) => {
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
});

it('keeps current-session tasks without saved names in the worker rows', async ({
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
});
