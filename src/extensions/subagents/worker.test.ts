import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi, onTestFinished } from 'vitest';

import { checkWorkerRuntime } from './loadout.js';
import { publish, readEvent } from './records.js';
import workerExtension from './worker.js';

vi.mock('./loadout.js', () => ({
  checkWorkerRuntime: vi.fn<typeof checkWorkerRuntime>().mockResolvedValue(undefined),
}));

it.each(['before readiness', 'before dispatch', 'before tool call'])(
  'leaves expiry to the parent when the wall clock jumps %s',
  async (phase) => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'tau-worker-clock-'));
    onTestFinished(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
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
    workerExtension({
      on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) =>
        handlers.set(name, handler),
      registerTool: vi.fn<ExtensionAPI['registerTool']>(),
      sendUserMessage,
    } as unknown as ExtensionAPI);
    const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, context);
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
