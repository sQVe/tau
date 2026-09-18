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

import { checkWorkerRuntime } from './loadout.js';
import { publish, readEvent, readPendingQuestion, readReport, recordEvent } from './records.js';
import * as records from './records.js';
import workerExtension from './worker.js';

vi.mock('./loadout.js', () => ({
  checkWorkerRuntime: vi.fn<typeof checkWorkerRuntime>().mockResolvedValue(undefined),
}));

const setup = () => {
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
    deadline: createdAt + 30_000,
    cancellationBudget: 2000,
    loadout: {
      profile: 'investigator',
      role: 'investigation',
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
      instructions: 'Read only.',
    },
  });
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  const tools = new Map<string, ToolDefinition>();
  const sendUserMessage = vi.fn<ExtensionAPI['sendUserMessage']>();
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
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, context);
  const ask = () =>
    tools
      .get('subagent_question')
      ?.execute('call', { question: 'Which file?' }, undefined, undefined, context);

  return { directory, createdAt, emit, ask, sendUserMessage, shutdown, events, tools, context };
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

const waitingWorker = async () => {
  const worker = setup();
  await worker.emit('session_start');
  publish(worker.directory, 'dispatch.json', { taskId: 'task' });
  await vi.advanceTimersByTimeAsync(50);
  await worker.emit('agent_start');

  return worker;
};

it.each([
  { parent: 'exited', running: false, closed: false, stopped: true, shutdowns: 1 },
  { parent: 'closed its controller', running: true, closed: true, stopped: true, shutdowns: 1 },
  { parent: 'kept running', running: true, closed: false, stopped: undefined, shutdowns: 0 },
])(
  'stops waiting for a reply only when the parent $parent',
  async ({ running, closed, stopped, shutdowns }) => {
    const { directory, emit, ask, shutdown } = await waitingWorker();
    expect(ask).toThrow('parent process');
    expect(readPendingQuestion(directory, 'task')).toBeUndefined();
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
      { outcome: 'incomplete', summary: 'Task ended.', evidence: [] },
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

  expect(readReport(worker.directory, 'task')?.summary).toContain('/saved/child-task');
  expect(worker.shutdown).toHaveBeenCalledOnce();
  await worker.emit('session_shutdown');
});

it('stops waiting after uncertain question publication once the parent exits', async () => {
  const { emit, ask, shutdown } = await waitingWorker();
  vi.stubEnv('TAU_PARENT_PROCESS', '4242');
  vi.spyOn(records, 'acceptQuestion').mockImplementation(() => {
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
