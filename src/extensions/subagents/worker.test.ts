import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEventResult,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createEventBus } from '@earendil-works/pi-coding-agent';
import { expect, it, vi, onTestFinished } from 'vitest';

import { monotonicNow } from './admission.js';
import { assignmentContract, handoffContract } from './handoff.js';
import { checkWorkerRuntime } from './loadout.js';
import * as questions from './questionRecords.js';
import { publish, readEvent, readReport, recordEvent } from './records.js';
import { textLimit } from './types.js';
import workerExtension from './worker.js';

vi.mock('./loadout.js', () => ({
  checkWorkerRuntime: vi.fn<typeof checkWorkerRuntime>().mockResolvedValue(undefined),
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
    ownerId: 'owner',
    nativeSessionId: 'native',
    nativeSessionFile: join(directory, 'native.jsonl'),
    createdAt,
    deadline: createdAt + window,
    cancellationBudget: 2000,
    tree: {
      rootSession: join(directory, 'parent.jsonl'),
      rootSessionId: 'parent',
      monotonicDeadline: monotonicNow() + window,
    },
    loadout: {
      harness: 'pi',
      profile: role === 'editing' ? 'worker' : 'investigator',
      role,
      model: 'faux/test',
      modelFingerprint: '0'.repeat(64),
      providerFingerprint: '0'.repeat(64),
      providerFingerprintVersion: 2,
      thinking: 'off',
      cwd: directory,
      agentDirectory: directory,
      permissions: 'trusted-full-tools',
      tools: ['read', 'bash', 'edit', 'write', 'subagent_report', 'subagent_question'],
      noExtensions: false,
      integrations: [join(directory, 'safety.js')],
      integrationFingerprint: '0'.repeat(64),
      safetyExtension: join(directory, 'safety.js'),
      instructions: 'Read only.',
    },
  });
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  const tools = new Map<string, ToolDefinition>();
  const sendUserMessage = vi.fn<ExtensionAPI['sendUserMessage']>();
  const sendMessage = vi.fn<ExtensionAPI['sendMessage']>();
  const shutdown = vi.fn<ExtensionContext['shutdown']>();
  const context = {
    sessionManager: {
      getSessionId: () => 'native',
      getSessionFile: () => join(directory, 'native.jsonl'),
    },
    shutdown,
    ui: { notify: vi.fn<ExtensionContext['ui']['notify']>() },
  } as unknown as ExtensionContext;
  const events = createEventBus();
  workerExtension({
    events,
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) =>
      handlers.set(name, handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    sendUserMessage,
    sendMessage,
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, context);
  const ask = () =>
    tools
      .get('subagent_question')
      ?.execute('call', { question: 'Which file?' }, undefined, undefined, context);

  return {
    directory,
    createdAt,
    emit,
    ask,
    sendUserMessage,
    sendMessage,
    shutdown,
    events,
    tools,
    context,
  };
};

it.each(['before readiness', 'before dispatch', 'before tool call'])(
  'leaves expiry to the parent when the wall clock jumps %s',
  async (phase) => {
    const { directory, createdAt, emit, sendUserMessage, shutdown } = setup();
    const jump = () => vi.setSystemTime(createdAt + 3_600_000);

    if (phase === 'before readiness') {
      jump();
    }

    await emit('session_start');
    expect(checkWorkerRuntime).toHaveBeenCalledOnce();
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

it.each(['deadline', 'parent stopped', 'question', 'reported', 'children'] as const)(
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
      vi.stubEnv('TAU_PARENT_PROCESS', String(process.pid));
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

    if (reason === 'children') {
      worker.events.on('tau:worker-children', (state: unknown) => {
        Object.assign(state as object, { active: 1 });
      });
    }

    await worker.emit('agent_end');

    expect(worker.sendMessage).not.toHaveBeenCalled();
  },
);

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
  { parent: 'exited', running: false, closed: false, stopped: true, shutdowns: 1 },
  { parent: 'closed its controller', running: true, closed: true, stopped: true, shutdowns: 1 },
  { parent: 'kept running', running: true, closed: false, stopped: undefined, shutdowns: 0 },
])(
  'stops waiting for a reply only when the parent $parent',
  async ({ running, closed, stopped, shutdowns }) => {
    const { directory, emit, ask, shutdown } = await waitingWorker();
    expect(ask).toThrow('parent process');
    expect(questions.readPendingQuestion(directory, 'task')).toBeUndefined();
    vi.stubEnv('TAU_PARENT_PROCESS', '4242');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (!running) {
        throw Object.assign(new Error('No such process.'), { code: 'ESRCH' });
      }

      return true;
    });

    await ask();

    if (closed) {
      recordEvent(directory, 'task', 'parentClosed', 'Parent controller closed.');
    }

    await vi.advanceTimersByTimeAsync(1000);

    expect(kill).toHaveBeenCalledWith(4242, 0);
    expect(shutdown).toHaveBeenCalledTimes(shutdowns);
    expect(readEvent(directory, 'task', 'settled')?.stopped).toBe(stopped);
    await emit('session_shutdown');
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('refuses reports for active children but includes uncertain cleanup in the final handover', async () => {
  const worker = await waitingWorker();
  const children = { active: 1, uncertain: [] as string[] };
  worker.events.on('tau:worker-children', (state: unknown) => {
    Object.assign(state as object, children);
  });
  const report = worker.tools.get('subagent_report');

  if (!report) {
    throw new Error('Missing report tool.');
  }

  const handover = () =>
    report.execute(
      'report',
      {
        outcome: 'incomplete',
        blocker: 'The parent must choose the storage format.',
        summary: 'Task ended.'.padEnd(textLimit, '.'),
        evidence: Array.from({ length: 100 }, (_value, index) => `Checked ${index}.`),
      },
      undefined,
      undefined,
      worker.context,
    );

  expect(handover).toThrow('Active children remain');
  await worker.emit('agent_settled');
  expect(worker.shutdown).not.toHaveBeenCalled();
  children.active = 0;
  children.uncertain.push(
    'Child child-task: cleanup unconfirmed; inspect /saved/child-task manually.',
  );
  await handover();
  await worker.emit('agent_settled');

  expect(readReport(worker.directory, 'task')?.summary).toHaveLength(textLimit);
  expect(readReport(worker.directory, 'task')?.evidence).toHaveLength(100);
  expect(readReport(worker.directory, 'task')?.evidence.at(-1)).toContain('/saved/child-task');
  expect(readReport(worker.directory, 'task')?.evidence.at(-1)).toContain('Dropped 1 evidence');
  expect(worker.shutdown).toHaveBeenCalledOnce();
  await worker.emit('session_shutdown');
});

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

  await reportIncomplete(worker, 'Tests remain.');

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

it('forwards child notice details to the worker session', async () => {
  const worker = await waitingWorker();

  worker.events.emit('tau:child-notification', {
    message: '{"taskId":"child"}',
    details: { taskId: 'child' },
    question: false,
  });

  expect(worker.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      customType: 'tau-worker-child',
      content: '{"taskId":"child"}',
      details: { taskId: 'child' },
    }),
    { deliverAs: 'followUp', triggerTurn: true },
  );
  await worker.emit('session_shutdown');
});

it('stops waiting after uncertain question publication once the parent exits', async () => {
  const { emit, ask, shutdown } = await waitingWorker();
  vi.stubEnv('TAU_PARENT_PROCESS', '4242');
  vi.spyOn(questions, 'acceptQuestion').mockImplementation(() => {
    throw new Error('Directory sync failed.');
  });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('No such process.'), { code: 'ESRCH' });
  });

  expect(ask).toThrow('Directory sync failed.');
  await vi.advanceTimersByTimeAsync(1000);

  expect(shutdown).toHaveBeenCalledOnce();
  await emit('session_shutdown');
  expect(vi.getTimerCount()).toBe(0);
});
