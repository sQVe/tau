import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExtensionContext,
  SessionEntry,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi, onTestFinished } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { readWorkerActivity, writeWorkerActivity } from './activity.js';
import { monotonicNow } from './controller/budget.js';
import { assignmentContract, handoffContract } from './handoff.js';
import { checkWorkerRuntime } from './loadout.js';
import * as questions from './questionRecords.js';
import { publish, readEvent, readReport, recordEvent } from './records.js';
import { textLimit } from './types.js';
import workerExtension from './workerExtension.js';

vi.mock('./loadout.js', () => ({
  checkWorkerRuntime: vi.fn<typeof checkWorkerRuntime>(),
}));

const setup = (role: 'editing' | 'investigation' = 'investigation', window = 30_000) => {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-clock-'));
  onTestFinished(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  vi.stubEnv('TAU_WORKER_RECORD', directory);
  const createdAt = Date.now();
  publish(directory, 'task.json', {
    version: 1,
    taskId: 'task',
    task: 'Read the assigned file.',
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent',
    nativeSessionId: 'native',
    nativeSessionFile: join(directory, 'native.jsonl'),
    createdAt,
    deadline: createdAt + window,
    cancellationBudget: 2000,
    monotonicDeadline: monotonicNow() + window,
    loadout: {
      harness: 'pi',
      profile: role === 'editing' ? 'worker' : 'investigator',
      role,
      model: 'faux/test',
      thinking: 'off',
      cwd: directory,
      agentDirectory: directory,
      permissions: 'trusted-full-tools',
      instructions: 'Read only.',
    },
  });
  const fake = fakeExtensionApi();
  const shutdown = vi.fn<ExtensionContext['shutdown']>();
  const branch: SessionEntry[] = [];
  const context = {
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => 'native',
      getSessionFile: () => join(directory, 'native.jsonl'),
    },
    shutdown,
    ui: { notify: vi.fn<ExtensionContext['ui']['notify']>() },
  } as unknown as ExtensionContext;
  workerExtension(fake.pi);
  const emit = (name: string, event: unknown = {}) =>
    fake.handlers.has(name) ? fake.handler(name)(event, context) : undefined;
  const ask = () =>
    fake.tools
      .get('subagent_question')
      ?.execute('call', { question: 'Which file?' }, undefined, undefined, context);

  return {
    directory,
    createdAt,
    emit,
    ask,
    sendUserMessage: fake.sendUserMessage,
    sendMessage: fake.sendMessage,
    shutdown,
    events: fake.pi.events,
    tools: fake.tools,
    context,
    branch,
  };
};

it('records a startup failure and shuts down when the worker runtime is refused', async () => {
  const { directory, emit, shutdown, context } = setup();
  vi.mocked(checkWorkerRuntime).mockImplementationOnce(() => {
    throw new Error('Saved model changed.');
  });

  await emit('session_start');

  expect(readEvent(directory, 'task', 'ready')).toBeUndefined();
  expect(readEvent(directory, 'task', 'startupFailure')).toHaveProperty(
    'detail',
    expect.stringContaining('Saved model changed.'),
  );
  expect(context.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining('Worker refused'),
    'error',
  );
  expect(shutdown).toHaveBeenCalledOnce();
});

it.each(['before readiness', 'before dispatch', 'before tool call'])(
  'leaves expiry to the parent when the wall clock jumps %s',
  async (phase) => {
    const { directory, createdAt, emit, sendUserMessage, shutdown } = setup();
    const jump = () => vi.setSystemTime(createdAt + 3_600_000);

    if (phase === 'before readiness') {
      jump();
    }

    await emit('session_start');
    expect(readEvent(directory, 'task', 'ready')).toBeDefined();

    if (phase === 'before dispatch') {
      jump();
    }

    publish(directory, 'dispatch.json', { taskId: 'task' });
    await vi.advanceTimersByTimeAsync(50);
    expect(sendUserMessage).toHaveBeenCalledOnce();
    await emit('agent_start');

    if (phase === 'before tool call') {
      jump();
    }

    const result = (await emit('tool_call', { toolName: 'read' })) as
      | ToolCallEventResult
      | undefined;

    expect(result).toBeUndefined();
    expect(shutdown).not.toHaveBeenCalled();
    await emit('session_shutdown');
    expect(vi.getTimerCount()).toBe(0);
  },
);

const assistantUsageEntry = (id: string, input: number, output: number): SessionEntry => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: new Date().toISOString(),
  message: {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'openai',
    model: 'fixture',
    timestamp: Date.now(),
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
  },
});

it('excludes earlier continuation history from the worker usage snapshot', async () => {
  const worker = setup();
  worker.branch.push(assistantUsageEntry('previous', 100, 30));
  await worker.emit('session_start');
  expect(readWorkerActivity(worker.directory, 'task')?.usage).toMatchObject({
    input: 0,
    output: 0,
  });
  worker.branch.push(assistantUsageEntry('current', 25, 5));
  worker.emit('tool_execution_start', { toolName: 'read' });

  expect(readWorkerActivity(worker.directory, 'task')?.usage).toMatchObject({
    input: 25,
    output: 5,
  });
  await worker.emit('session_shutdown');
});

it('records Pi activity and tool names without recording tool input', async () => {
  const worker = setup();
  await worker.emit('session_start');
  worker.emit('tool_execution_start', { toolName: 'read', input: { path: '/private/file' } });

  const activity = readWorkerActivity(worker.directory, 'task');

  expect(activity?.phase).toBe('active');
  expect(activity?.label).toBe('tool: read');
  expect(JSON.stringify(activity)).not.toContain('/private/file');
  await worker.emit('session_shutdown');
});

const waitingWorker = async (
  role: 'editing' | 'investigation' = 'investigation',
  window = 30_000,
) => {
  const worker = setup(role, window);
  await worker.emit('session_start');
  publish(worker.directory, 'dispatch.json', { taskId: 'task' });
  await vi.advanceTimersByTimeAsync(50);
  await worker.emit('agent_start');

  return worker;
};

it('requests a missing report once before the worker settles', async () => {
  const worker = await waitingWorker();

  await worker.emit('agent_end');
  await worker.emit('agent_end');

  expect(worker.sendMessage).toHaveBeenCalledOnce();
  expect(worker.sendMessage.mock.calls[0]?.[0].content).toContain('subagent_report');
  expect(worker.sendMessage.mock.calls[0]?.[1]).toMatchObject({
    triggerTurn: true,
    deliverAs: 'followUp',
  });
  expect(worker.shutdown).not.toHaveBeenCalled();
  expect(readEvent(worker.directory, 'task', 'settled')).toBeUndefined();
  await worker.emit('agent_settled');
  expect(worker.shutdown).toHaveBeenCalledOnce();
});

it.each(['deadline', 'parent stopped', 'question', 'reported'] as const)(
  'does not request a report when blocked by %s',
  async (reason) => {
    const worker = await waitingWorker();

    if (reason === 'deadline') {
      await vi.advanceTimersByTimeAsync(28_000);
    }

    if (reason === 'parent stopped') {
      recordEvent(worker.directory, 'task', 'stopping', 'Parent is stopping.');
    }

    if (reason === 'question') {
      await worker.ask();
    }

    if (reason === 'reported') {
      await worker.tools.get('subagent_report')!.execute(
        'report',
        {
          outcome: 'success',
          summary: 'Done.',
          evidence: [],
        },
        undefined,
        undefined,
        worker.context,
      );
    }

    await worker.emit('agent_end');

    expect(worker.sendMessage).not.toHaveBeenCalled();
  },
);

it('keeps settled activity when a streaming update was still pending', async () => {
  const worker = await waitingWorker();
  worker.emit('message_update');
  await worker.emit('agent_settled');
  const settled = readWorkerActivity(worker.directory, 'task');

  await vi.advanceTimersByTimeAsync(500);

  expect(settled?.phase).toBe('done');
  expect(readWorkerActivity(worker.directory, 'task')).toEqual(settled);
  expect(worker.shutdown).toHaveBeenCalledOnce();
});

it('leaves activity unchanged when a queued update outlives its Pi context', async () => {
  const worker = await waitingWorker();
  worker.emit('message_update');
  const before = readWorkerActivity(worker.directory, 'task');
  Object.defineProperty(worker.context, 'sessionManager', {
    get() {
      throw new Error('This extension ctx is stale after session replacement or reload.');
    },
  });

  expect(() => vi.advanceTimersByTime(500)).not.toThrow();
  expect(readWorkerActivity(worker.directory, 'task')).toEqual(before);
  await worker.emit('session_shutdown');
});

it('leaves activity unchanged when Pi session usage is unavailable during a tool event', async () => {
  const worker = await waitingWorker();
  const before = readWorkerActivity(worker.directory, 'task');
  vi.spyOn(worker.context.sessionManager, 'getBranch').mockImplementation(() => {
    throw new Error('Session usage unavailable.');
  });

  expect(() => worker.emit('tool_execution_start', { toolName: 'read' })).not.toThrow();
  expect(readWorkerActivity(worker.directory, 'task')).toEqual(before);
  await worker.emit('session_shutdown');
});

it('publishes a worker phase description while keeping lifecycle, automatic activity, model, and usage', async () => {
  const worker = await waitingWorker();
  worker.branch.push(assistantUsageEntry('current', 25, 5));
  worker.emit('tool_execution_start', { toolName: 'read' });
  const progress = worker.tools.get('subagent_progress');

  if (!progress) {
    throw new Error('Missing progress tool.');
  }

  await progress.execute(
    'progress',
    { description: 'Running focused tests' },
    undefined,
    undefined,
    worker.context,
  );
  const reported = readWorkerActivity(worker.directory, 'task');

  expect(reported).toMatchObject({
    description: 'Running focused tests',
    descriptionAt: Date.now(),
    phase: 'active',
    label: 'tool: read',
    usage: { input: 25, output: 5 },
  });

  worker.emit('tool_execution_end', { toolName: 'read' });
  const afterAutomaticActivity = readWorkerActivity(worker.directory, 'task');

  expect(afterAutomaticActivity).toMatchObject({
    description: 'Running focused tests',
    descriptionAt: Date.now(),
    label: 'tool finished: read',
  });
  await worker.emit('session_shutdown');
});

it('refuses an invalid or empty phase description without changing the saved activity', async () => {
  const worker = await waitingWorker();
  worker.emit('tool_execution_start', { toolName: 'read' });
  const before = readWorkerActivity(worker.directory, 'task');
  const progress = worker.tools.get('subagent_progress');

  if (!progress) {
    throw new Error('Missing progress tool.');
  }

  for (const description of ['', '   ', 'line\nbreak', `x${'y'.repeat(200)}`]) {
    expect(() =>
      progress.execute('progress', { description }, undefined, undefined, worker.context),
    ).toThrow('Progress description');
  }

  expect(readWorkerActivity(worker.directory, 'task')).toEqual(before);
  await worker.emit('session_shutdown');
});

it('refuses progress without an active task and after the final handover', async () => {
  const idle = setup();
  const idleProgress = idle.tools.get('subagent_progress');

  if (!idleProgress) {
    throw new Error('Missing progress tool.');
  }

  expect(() =>
    idleProgress.execute(
      'progress',
      { description: 'Inspecting' },
      undefined,
      undefined,
      idle.context,
    ),
  ).toThrow('active task');

  const worker = await waitingWorker();
  const progress = worker.tools.get('subagent_progress');
  const report = worker.tools.get('subagent_report');

  if (!progress || !report) {
    throw new Error('Missing worker tools.');
  }

  await report.execute(
    'report',
    { outcome: 'success', summary: 'Done.', evidence: [] },
    undefined,
    undefined,
    worker.context,
  );
  const afterReport = readWorkerActivity(worker.directory, 'task');

  expect(() =>
    progress.execute(
      'progress',
      { description: 'Checking full suite' },
      undefined,
      undefined,
      worker.context,
    ),
  ).toThrow('active task');
  expect(readWorkerActivity(worker.directory, 'task')).toEqual(afterReport);
  await worker.emit('session_shutdown');
});

it('does not attribute a predecessor phase to the current task', async () => {
  const worker = setup();
  writeWorkerActivity(worker.directory, {
    taskId: 'previous',
    sequence: 5,
    updatedAt: Date.now() - 1000,
    phase: 'active',
    label: 'tool: bash',
    description: 'Checking the predecessor suite',
    descriptionAt: Date.now() - 1000,
  });
  await worker.emit('session_start');

  const activity = readWorkerActivity(worker.directory, 'task');

  expect(activity?.description).toBeUndefined();
  expect(activity?.label).toBe('Pi worker starting');
  await worker.emit('session_shutdown');
});

it('sends the autonomous assignment and handoff contract to a dispatched Pi editing worker', async () => {
  const worker = await waitingWorker('editing');
  const prompt = worker.sendUserMessage.mock.calls[0]?.[0];

  expect(typeof prompt).toBe('string');
  expect(prompt).toContain(assignmentContract);
  expect(prompt).toContain(handoffContract);
  await worker.emit('session_shutdown');
});

it('keeps the editing assignment out of a dispatched Pi investigator prompt', async () => {
  const worker = await waitingWorker('investigation');
  const prompt = worker.sendUserMessage.mock.calls[0]?.[0];

  expect(typeof prompt).toBe('string');
  expect(prompt).toContain(handoffContract);
  expect(prompt).not.toContain(assignmentContract);
  await worker.emit('session_shutdown');
});

it.each([
  {
    condition: 'parent is absent',
    closed: false,
    expired: false,
    stopped: undefined,
    shutdowns: 0,
  },
  { condition: 'parent closed', closed: true, expired: false, stopped: true, shutdowns: 1 },
  { condition: 'deadline passed', closed: false, expired: true, stopped: true, shutdowns: 1 },
])(
  'ends the reply wait only on closure or expiry when $condition',
  async ({ closed, expired, stopped, shutdowns }) => {
    const { directory, createdAt, emit, ask, shutdown } = await waitingWorker();
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('No such process.'), { code: 'ESRCH' });
    });

    await ask();

    if (closed) {
      recordEvent(directory, 'task', 'parentClosed', 'Parent controller closed.');
    }

    if (expired) {
      vi.setSystemTime(createdAt + 30_000);
    }

    await vi.advanceTimersByTimeAsync(1000);

    expect(questions.readPendingQuestion(directory, 'task')).toBeDefined();
    expect(shutdown).toHaveBeenCalledTimes(shutdowns);
    expect(readEvent(directory, 'task', 'settled')?.stopped).toBe(stopped);
    await emit('session_shutdown');
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('saves the handoff sections and work reference from a Pi report', async () => {
  const worker = await waitingWorker('editing');
  const report = worker.tools.get('subagent_report');

  if (!report) {
    throw new Error('Missing report tool.');
  }

  const summary = [
    'Changes: edited src/value.ts against baseline 3ee3d7a; untracked notes.md',
    'Evidence: pnpm check passed; record at /saved/run.json',
    'Decisions: none',
    'Concerns: none',
  ].join('\n');
  const evidence = ['git diff --stat: src/value.ts | 2 +-'];

  await report.execute(
    'report',
    { outcome: 'success', summary, evidence },
    undefined,
    undefined,
    worker.context,
  );

  const saved = readReport(worker.directory, 'task');
  expect(saved?.summary).toBe(summary);
  expect(saved?.evidence).toEqual(evidence);
  await worker.emit('session_shutdown');
});

const hour = 3_600_000;

const reportIncomplete = (worker: Awaited<ReturnType<typeof waitingWorker>>, blocker?: string) => {
  const report = worker.tools.get('subagent_report');

  if (!report) {
    throw new Error('Missing report tool.');
  }

  return report.execute(
    'report',
    {
      outcome: 'incomplete',
      summary: 'Implementation done. Regression tests remain.',
      evidence: [],
      ...(blocker === undefined ? {} : { blocker }),
    },
    undefined,
    undefined,
    worker.context,
  );
};

it('refuses an incomplete report without a blocker', async () => {
  const worker = await waitingWorker('editing');

  expect(() => reportIncomplete(worker)).toThrow('blocker');
  expect(readReport(worker.directory, 'task')).toBeUndefined();
});

it('refuses an incomplete report with a blank blocker', async () => {
  const worker = await waitingWorker('editing');

  expect(() => reportIncomplete(worker, ' ')).toThrow('blocker');
  expect(readReport(worker.directory, 'task')).toBeUndefined();
});

it('refuses the first incomplete report while meaningful time remains', async () => {
  const worker = await waitingWorker('editing', hour);

  expect(() => reportIncomplete(worker, 'Tests remain.')).toThrow('minutes remain');
  expect(readReport(worker.directory, 'task')).toBeUndefined();

  await reportIncomplete(worker, 'The parent must choose the storage format.');

  expect(readReport(worker.directory, 'task')?.outcome).toBe('incomplete');
  expect(readReport(worker.directory, 'task')?.summary).toContain(
    'The parent must choose the storage format.',
  );
});

it('refuses the first incomplete report just above the time bar', async () => {
  const worker = await waitingWorker('editing', hour);
  await vi.advanceTimersByTimeAsync(47 * 60_000);

  expect(() => reportIncomplete(worker, 'Tests remain.')).toThrow('minutes remain');
  expect(readReport(worker.directory, 'task')).toBeUndefined();
});

it('accepts the first incomplete report just below the time bar', async () => {
  const worker = await waitingWorker('editing', hour);
  await vi.advanceTimersByTimeAsync(49 * 60_000);

  await reportIncomplete(worker, 'The parent must choose the storage format.');

  expect(readReport(worker.directory, 'task')?.outcome).toBe('incomplete');
});

it('reminds a refused worker to report even after an earlier reminder', async () => {
  const worker = await waitingWorker('editing', hour);
  await worker.emit('agent_end');
  expect(() => reportIncomplete(worker, 'Tests remain.')).toThrow('minutes remain');

  await worker.emit('agent_end');
  await worker.emit('agent_end');

  expect(worker.sendMessage).toHaveBeenCalledTimes(2);
  expect(worker.shutdown).not.toHaveBeenCalled();
});

it('reminds a worker refused for a missing blocker even after an earlier reminder', async () => {
  const worker = await waitingWorker('editing', hour);
  await worker.emit('agent_end');
  expect(() => reportIncomplete(worker)).toThrow('blocker');

  await worker.emit('agent_end');

  expect(worker.sendMessage).toHaveBeenCalledTimes(2);
});

it('keeps the blocker when the summary is at the size limit', async () => {
  const worker = await waitingWorker('editing');
  const report = worker.tools.get('subagent_report');

  if (!report) {
    throw new Error('Missing report tool.');
  }

  await report.execute(
    'report',
    {
      outcome: 'incomplete',
      summary: 'Task ended.'.padEnd(textLimit, '.'),
      evidence: [],
      blocker: 'The parent must choose the storage format.',
    },
    undefined,
    undefined,
    worker.context,
  );

  const summary = readReport(worker.directory, 'task')?.summary;
  expect(summary).toHaveLength(textLimit);
  expect(summary).toContain('Blocker: The parent must choose the storage format.\n\nTask ended.');
});

it('accepts a success report after refusing an incomplete one', async () => {
  const worker = await waitingWorker('editing', hour);
  expect(() => reportIncomplete(worker, 'Tests remain.')).toThrow('minutes remain');

  const report = worker.tools.get('subagent_report');

  if (!report) {
    throw new Error('Missing report tool.');
  }

  await report.execute(
    'report',
    { outcome: 'success', summary: 'All done.', evidence: [], blocker: 'None.' },
    undefined,
    undefined,
    worker.context,
  );

  expect(readReport(worker.directory, 'task')?.outcome).toBe('success');
  expect(readReport(worker.directory, 'task')?.summary).toBe('All done.');
});

it('stops waiting after uncertain question publication once the deadline passes', async () => {
  const { directory, createdAt, emit, ask, shutdown } = await waitingWorker();
  vi.spyOn(questions, 'acceptQuestion').mockImplementation(() => {
    throw new Error('Directory sync failed.');
  });
  expect(ask).toThrow('Directory sync failed.');
  await vi.advanceTimersByTimeAsync(1000);
  expect(shutdown).not.toHaveBeenCalled();

  vi.setSystemTime(createdAt + 30_000);
  await vi.advanceTimersByTimeAsync(1000);

  expect(shutdown).toHaveBeenCalledOnce();
  expect(readEvent(directory, 'task', 'settled')?.stopped).toBe(true);
  await emit('session_shutdown');
  expect(vi.getTimerCount()).toBe(0);
});
