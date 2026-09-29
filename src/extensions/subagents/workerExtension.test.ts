import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentBeforeSettleEventResult,
  ExtensionContext,
  ExtensionToolContext,
  SessionEntry,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi, onTestFinished } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { readInstructionSet } from '../../instructionSets/index.js';
import { readWorkerActivity, writeWorkerActivity } from './activity.js';
import { monotonicNow } from './controller/budget.js';
import { taskRecordStatus } from './controller/record.js';
import { assignmentContract, handoffContract } from './handoff.js';
import { checkWorkerRuntime } from './loadout.js';
import * as questions from './questionRecords.js';
import { publish, readEvent, readReport, readTask, recordEvent } from './records.js';
import { textLimit } from './types.js';
import workerExtension from './workerExtension.js';

vi.mock('./loadout.js', () => ({
  checkWorkerRuntime: vi.fn<typeof checkWorkerRuntime>(),
}));

const emptyEvent = { messages: [] };

const sections = '\n\nChanges: None\nEvidence: None\nDecisions: None\nConcerns: None';

const setup = (
  role: 'editing' | 'investigation' = 'investigation',
  window = 30_000,
  parentClockLead = 0,
) => {
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
    version: 6,
    taskId: 'task',
    task: 'Read the assigned file.',
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent',
    nativeSessionId: 'native',
    nativeSessionFile: join(directory, 'native.jsonl'),
    createdAt,
    deadline: createdAt + window,
    cancellationBudget: 2000,
    monotonicDeadline: monotonicNow() + parentClockLead + window,
    loadout: {
      harness: 'pi',
      profile: role === 'editing' ? 'worker' : 'scout',
      role,
      model: 'faux/test',
      thinking: 'off',
      cwd: directory,
      agentDirectory: directory,
      permissions: 'trusted-full-tools',
      instructions: 'Read only.',
      tools: ['read', 'bash'],
      skills: [],
      instructionSets:
        role === 'editing' ? ['writing', 'coding', 'workflow'] : ['writing', 'workflow'],
      packages: [],
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
  } as unknown as ExtensionToolContext;

  workerExtension(fake.pi);

  const emit = (name: string, event: unknown = emptyEvent) =>
    fake.handlers.has(name) ? fake.handler(name)(event, context) : undefined;

  const settle = async (endEvent: unknown = emptyEvent) => {
    await emit('agent_end', endEvent);

    const boundary = { entries: [], continue: false, context: {}, outcome: 'completed' };

    const result = (await emit('agent_before_settle', boundary)) as
      | AgentBeforeSettleEventResult
      | undefined;

    return result ?? {};
  };

  const ask = () =>
    fake.tools
      .get('subagent_question')
      ?.execute('call', { question: 'Which file?' }, undefined, undefined, context);

  return {
    directory,
    createdAt,
    emit,
    settle,
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
  parentClockLead = 0,
) => {
  const worker = setup(role, window, parentClockLead);
  await worker.emit('session_start');
  publish(worker.directory, 'dispatch.json', { taskId: 'task' });
  await vi.advanceTimersByTimeAsync(50);
  await worker.emit('agent_start');

  return worker;
};

it.each([
  ['session_before_switch', { type: 'session_before_switch', reason: 'new' }],
  ['session_before_switch', { type: 'session_before_switch', reason: 'resume' }],
  ['session_before_fork', { type: 'session_before_fork', entryId: 'entry', position: 'at' }],
])('cancels %s during a task', async (name, event) => {
  const worker = await waitingWorker();

  expect(await worker.emit(name, event)).toEqual({ cancel: true });
  expect(readEvent(worker.directory, 'task', 'accepted')).toBeDefined();
  expect(worker.shutdown).not.toHaveBeenCalled();
  await worker.emit('session_shutdown');
});

const reportReminders = (result: AgentBeforeSettleEventResult) =>
  (result.entries ?? []).filter(
    (entry) => entry.type === 'custom_message' && entry.customType === 'tau-worker-report-request',
  );

it('requests a missing report once before the worker settles', async () => {
  const worker = await waitingWorker();

  const first = await worker.settle();
  const second = await worker.settle();

  expect(reportReminders(first)).toHaveLength(1);
  expect(first.continue).toBe(true);
  expect(reportReminders(second)).toHaveLength(0);
  expect(second.continue).toBeUndefined();
  expect(worker.sendMessage).not.toHaveBeenCalled();
  expect(worker.shutdown).not.toHaveBeenCalled();
  expect(readEvent(worker.directory, 'task', 'settled')).toBeUndefined();
  await worker.emit('agent_settled');
  expect(worker.shutdown).toHaveBeenCalledOnce();
});

it('keeps boundary entries from earlier extensions when it requests a report', async () => {
  const worker = await waitingWorker();
  const earlier = { type: 'custom', customType: 'other-extension' } as const;

  const result = (await worker.emit('agent_before_settle', {
    entries: [earlier],
    continue: false,
    context: {},
    outcome: 'completed',
  })) as AgentBeforeSettleEventResult;

  expect(result.entries?.[0]).toEqual(earlier);
  expect(reportReminders(result)).toHaveLength(1);
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
          summary: `Done.${sections}`,
          evidence: [],
        },
        undefined,
        undefined,
        worker.context,
      );
    }

    const result = await worker.settle();

    expect(reportReminders(result)).toHaveLength(0);
    expect(result.continue).toBeUndefined();
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
    { outcome: 'success', summary: `Done.${sections}`, evidence: [] },
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

it.each([
  { role: 'editing', assignment: true },
  { role: 'investigation', assignment: false },
] as const)(
  'puts the $role instructions in the system prompt, not the task message',
  async ({ role, assignment }) => {
    const worker = await waitingWorker(role);
    const prompt = worker.sendUserMessage.mock.calls[0]?.[0];
    const { instructions } = readTask(worker.directory).loadout;

    const systemPromptOptions = { appendSystemPrompt: 'user append' };

    expect(
      await worker.emit('before_agent_start', { systemPrompt: 'base', systemPromptOptions }),
    ).toBeUndefined();

    const appended = systemPromptOptions.appendSystemPrompt;

    expect(appended.startsWith('user append\n\n')).toBe(true);
    expect(appended).toContain(instructions);
    expect(appended).toContain(handoffContract);
    expect(appended.includes(assignmentContract)).toBe(assignment);
    expect(prompt).not.toContain(instructions);
    expect(prompt).not.toContain(handoffContract);
    await worker.emit('session_shutdown');
  },
);

it.each([
  { role: 'editing', sets: ['writing', 'coding', 'workflow'], omitted: [] },
  { role: 'investigation', sets: ['writing', 'workflow'], omitted: ['coding'] },
] as const)(
  'appends the $role loadout instruction sets in order after the worker instructions',
  async ({ role, sets, omitted }) => {
    const worker = await waitingWorker(role);
    const loadoutInstructions = readTask(worker.directory).loadout.instructions;
    const systemPromptOptions = { appendSystemPrompt: '' };

    await worker.emit('before_agent_start', { systemPrompt: 'base', systemPromptOptions });

    const appended = systemPromptOptions.appendSystemPrompt;
    const texts = await Promise.all(sets.map((name) => readInstructionSet(name)));
    const positions = texts.map((text) => appended.indexOf(text));

    expect(positions.every((position) => position > appended.indexOf(loadoutInstructions))).toBe(
      true,
    );

    expect(positions).toEqual(positions.toSorted((first, second) => first - second));

    for (const name of omitted) {
      expect(appended).not.toContain(await readInstructionSet(name));
    }

    await worker.emit('session_shutdown');
  },
);

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

it('refuses a report that misses handoff sections until the worker resends them', async () => {
  const worker = await waitingWorker('editing');
  const report = worker.tools.get('subagent_report');

  if (!report) {
    throw new Error('Missing report tool.');
  }

  const send = (summary: string) =>
    report.execute(
      'report',
      { outcome: 'success', summary, evidence: [] },
      undefined,
      undefined,
      worker.context,
    );

  expect(() => send('## Changes\n- src/value.ts\n\nEvidence: pnpm check passed')).toThrow(
    'Decisions, Concerns',
  );

  expect(readReport(worker.directory, 'task')).toBeUndefined();

  await send(
    '## Changes\n- src/value.ts\n**Evidence**\n- pnpm check passed\nDECISIONS: None\n### Concerns (open)\nNone',
  );

  expect(readReport(worker.directory, 'task')?.outcome).toBe('success');
});

const hour = 3_600_000;

const reportIncomplete = (
  worker: Awaited<ReturnType<typeof waitingWorker>>,
  blocker?: string,
  blockerKind: string | null = 'dependency',
) => {
  const report = worker.tools.get('subagent_report');

  if (!report) {
    throw new Error('Missing report tool.');
  }

  return report.execute(
    'report',
    {
      outcome: 'incomplete',
      summary: `Implementation done. Regression tests remain.${sections}`,
      evidence: [],
      ...(blocker === undefined ? {} : { blocker }),
      ...(blockerKind === null ? {} : { blockerKind }),
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

it('refuses an incomplete report without a blocker kind', async () => {
  const worker = await waitingWorker('editing');

  expect(() => reportIncomplete(worker, 'The parent must choose.', null)).toThrow('blockerKind');

  expect(readReport(worker.directory, 'task')).toBeUndefined();
});

it('keeps refusing a repeated time blocker while meaningful time remains', async () => {
  const worker = await waitingWorker('editing', hour);

  expect(() => reportIncomplete(worker, 'Time ran out.', 'time')).toThrow('remain');
  expect(() => reportIncomplete(worker, 'Time ran out.', 'time')).toThrow('remain');
  expect(readReport(worker.directory, 'task')).toBeUndefined();
  expect(readEvent(worker.directory, 'task', 'settled')).toBeUndefined();
});

it('accepts a time blocker near the end of the task', async () => {
  const worker = await waitingWorker('editing', hour);
  await vi.advanceTimersByTimeAsync(55 * 60_000);

  await reportIncomplete(worker, 'Time ran out.', 'time');

  expect(readReport(worker.directory, 'task')?.outcome).toBe('incomplete');
});

const incidentWindow = 240_000;

it('refuses a time blocker and its retry early in a four-minute task', async () => {
  const worker = await waitingWorker('editing', incidentWindow);
  await vi.advanceTimersByTimeAsync(33_000);

  expect(() => reportIncomplete(worker, 'Time ran out.', 'time')).toThrow('remain');
  await vi.advanceTimersByTimeAsync(24_000);
  expect(() => reportIncomplete(worker, 'Time ran out.', 'time')).toThrow('remain');
  expect(readReport(worker.directory, 'task')).toBeUndefined();
  expect(readEvent(worker.directory, 'task', 'settled')).toBeUndefined();
});

it('accepts a time blocker in the last tenth of a four-minute task', async () => {
  const worker = await waitingWorker('editing', incidentWindow);
  await vi.advanceTimersByTimeAsync(215_000);

  await reportIncomplete(worker, 'Time ran out.', 'time');

  expect(readReport(worker.directory, 'task')?.outcome).toBe('incomplete');
});

it.each(['dependency', 'decision'])(
  'accepts an early %s blocker in a four-minute task',
  async (blockerKind) => {
    const worker = await waitingWorker('editing', incidentWindow);
    await vi.advanceTimersByTimeAsync(33_000);

    await reportIncomplete(worker, 'The parent must choose the storage format.', blockerKind);

    expect(readReport(worker.directory, 'task')?.outcome).toBe('incomplete');
  },
);

it('measures remaining time on the worker clock when the parent process clock leads', async () => {
  const worker = await waitingWorker('editing', hour, 20 * 60_000);
  await vi.advanceTimersByTimeAsync(55 * 60_000);

  await reportIncomplete(worker, 'Time ran out.', 'time');

  expect(readReport(worker.directory, 'task')?.outcome).toBe('incomplete');
});

const deadlineWarnings = (worker: Awaited<ReturnType<typeof waitingWorker>>) =>
  worker.sendMessage.mock.calls.filter(([message]) => message.customType === 'tau-worker-deadline');

it('warns a worker once when its deadline accepts a time blocker', async () => {
  const worker = await waitingWorker('editing', 240_000);

  await vi.advanceTimersByTimeAsync(147_000);
  expect(deadlineWarnings(worker)).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1000);

  expect(deadlineWarnings(worker)).toHaveLength(1);
  expect(deadlineWarnings(worker)[0]?.[1]).toMatchObject({ deliverAs: 'steer', triggerTurn: true });

  await vi.advanceTimersByTimeAsync(1000);
  await reportIncomplete(worker, 'Time ran out.', 'time');
  await vi.advanceTimersByTimeAsync(90_000);

  expect(deadlineWarnings(worker)).toHaveLength(1);
  expect(readReport(worker.directory, 'task')?.outcome).toBe('incomplete');
});

it('sends no deadline warning after a report', async () => {
  const worker = await waitingWorker('editing', 240_000);

  await worker.tools
    .get('subagent_report')!
    .execute(
      'report',
      { outcome: 'success', summary: `Done.${sections}`, evidence: [] },
      undefined,
      undefined,
      worker.context,
    );

  await vi.advanceTimersByTimeAsync(240_000);

  expect(deadlineWarnings(worker)).toHaveLength(0);
});

it.each(['error', 'aborted'] as const)(
  'settles a worker whose final turn ended with %s without a reminder, and shows the error to the parent',
  async (stopReason) => {
    const worker = await waitingWorker();

    const result = await worker.settle({
      messages: [
        { role: 'assistant', content: [], stopReason, errorMessage: 'Invalid tool schema.' },
      ],
    });

    expect(reportReminders(result)).toHaveLength(0);
    expect(result.continue).toBeUndefined();
    await worker.emit('agent_settled');
    expect(worker.shutdown).toHaveBeenCalledOnce();

    const status = taskRecordStatus(worker.directory, readTask(worker.directory), false, []);

    expect(status.failure).toContain('Invalid tool schema.');
    expect(status.outcome).toBe('incomplete');
  },
);

it('keeps a reported outcome free of the settled detail', async () => {
  const worker = await waitingWorker();

  await worker.tools
    .get('subagent_report')!
    .execute(
      'report',
      { outcome: 'success', summary: `Done.${sections}`, evidence: [] },
      undefined,
      undefined,
      worker.context,
    );

  await worker.settle();
  await worker.emit('agent_settled');

  const status = taskRecordStatus(worker.directory, readTask(worker.directory), false, []);

  expect(status.failure).toBeUndefined();
  expect(status.outcome).toBe('success');
});

it('reminds a refused worker to report even after an earlier reminder', async () => {
  const worker = await waitingWorker('editing', hour);
  await worker.settle();
  expect(() => reportIncomplete(worker, 'Tests remain.')).toThrow('minutes remain');

  const afterRefusal = await worker.settle();
  const later = await worker.settle();

  expect(reportReminders(afterRefusal)).toHaveLength(1);
  expect(reportReminders(later)).toHaveLength(0);
  expect(worker.shutdown).not.toHaveBeenCalled();
});

it('reminds a worker refused for a missing blocker even after an earlier reminder', async () => {
  const worker = await waitingWorker('editing', hour);
  await worker.settle();
  expect(() => reportIncomplete(worker)).toThrow('blocker');

  const afterRefusal = await worker.settle();

  expect(reportReminders(afterRefusal)).toHaveLength(1);
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
      summary: `Task ended.${sections}`.padEnd(textLimit, '.'),
      evidence: [],
      blocker: 'The parent must choose the storage format.',
      blockerKind: 'decision',
    },
    undefined,
    undefined,
    worker.context,
  );

  const summary = readReport(worker.directory, 'task')?.summary;
  expect(summary).toHaveLength(textLimit);
  expect(summary).toContain('Blocker: The parent must choose the storage format.\n\nTask ended.');
});

it('refuses a full-size report whose blocker would push out a section', async () => {
  const worker = await waitingWorker('editing');
  const report = worker.tools.get('subagent_report');

  if (!report) {
    throw new Error('Missing report tool.');
  }

  const body = 'Changes: None\nEvidence: None\nDecisions: None\n';

  expect(() =>
    report.execute(
      'report',
      {
        outcome: 'incomplete',
        summary: `${body.padEnd(textLimit - '\nConcerns: None'.length, '.')}\nConcerns: None`,
        evidence: [],
        blocker: 'The parent must choose the storage format.',
      },
      undefined,
      undefined,
      worker.context,
    ),
  ).toThrow('Concerns');

  expect(readReport(worker.directory, 'task')).toBeUndefined();
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
    { outcome: 'success', summary: `All done.${sections}`, evidence: [], blocker: 'None.' },
    undefined,
    undefined,
    worker.context,
  );

  expect(readReport(worker.directory, 'task')?.outcome).toBe('success');
  expect(readReport(worker.directory, 'task')?.summary).toBe(`All done.${sections}`);
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

const saveReply = (directory: string, questionId: string) => {
  questions.acceptReply(directory, 'task', {
    version: 1,
    taskId: 'task',
    questionId,
    replyId: 'reply',
    reply: 'Read notes.md.',
  });
};

it('acknowledges a saved reply and lets only that message through the input hook', async () => {
  const { directory, emit, ask, sendUserMessage } = await waitingWorker();
  const { details } = (await ask()) as { details: { questionId: string } };

  expect(await emit('input', { text: 'typed', source: 'interactive' })).toEqual({
    action: 'handled',
  });

  saveReply(directory, details.questionId);
  await vi.advanceTimersByTimeAsync(1000);
  // The question turn has not settled yet, so delivering now would let that settle end the task.
  expect(questions.readAcknowledgement(directory, 'task', details.questionId)).toBeUndefined();

  await emit('agent_settled');
  await vi.advanceTimersByTimeAsync(2000);
  expect(readEvent(directory, 'task', 'settled')).toBeUndefined();
  expect(sendUserMessage).toHaveBeenCalledTimes(2);

  expect(sendUserMessage).toHaveBeenLastCalledWith(expect.stringContaining('Read notes.md.'), {
    deliverAs: 'followUp',
  });

  // Pi can drop the message before the input hook, so only the hook proves the session took it.
  expect(questions.readAcknowledgement(directory, 'task', details.questionId)).toBeUndefined();
  const [text] = sendUserMessage.mock.lastCall ?? [];

  expect(await emit('input', { text: 'other', source: 'extension' })).toEqual({
    action: 'handled',
  });

  expect(await emit('input', { text, source: 'extension' })).toEqual({ action: 'continue' });

  expect(questions.readAcknowledgement(directory, 'task', details.questionId)).toMatchObject({
    replyId: 'reply',
  });

  expect(questions.readPendingQuestion(directory, 'task')).toBeUndefined();
  expect(await emit('input', { text, source: 'extension' })).toEqual({ action: 'handled' });
  await emit('session_shutdown');
});

it('leaves a reply saved after the wait ended unacknowledged', async () => {
  const { directory, createdAt, emit, ask, sendUserMessage, shutdown } = await waitingWorker();
  const { details } = (await ask()) as { details: { questionId: string } };

  sendUserMessage.mockClear();
  await emit('agent_settled');
  vi.setSystemTime(createdAt + 30_000);
  saveReply(directory, details.questionId);
  await vi.advanceTimersByTimeAsync(1000);

  expect(shutdown).toHaveBeenCalledOnce();
  expect(questions.readAcknowledgement(directory, 'task', details.questionId)).toBeUndefined();
  expect(sendUserMessage).not.toHaveBeenCalled();
  await emit('session_shutdown');
});
