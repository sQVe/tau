import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createEventBus } from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';
import { expect, it, vi } from 'vitest';

import { WorkerController } from './controller.js';
import subagentsExtension from './index.js';

it('places follow-ups with explicit visibility and the current parent terminal', async ({
  onTestFinished,
}) => {
  const tools = new Map<string, ToolDefinition>();
  subagentsExtension({
    events: createEventBus(),
    on: () => undefined,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI);
  const tool = tools.get('subagent_follow_up');
  if (!tool) {
    throw new Error('Missing follow-up tool.');
  }
  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'stale-pane-before-movement');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');
  vi.spyOn(WorkerController.prototype, 'parentAuthority').mockResolvedValue({
    tree: {
      rootSession: '/fixture/parent.jsonl',
      rootSessionId: 'parent',
      monotonicDeadline: Number.MAX_SAFE_INTEGER,
    },
  });
  const followUp = vi
    .spyOn(WorkerController.prototype, 'followUp')
    .mockResolvedValue({} as Awaited<ReturnType<WorkerController['followUp']>>);
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const context = {
    sessionManager: { getSessionFile: () => '/fixture/parent.jsonl', getSessionId: () => 'parent' },
  } as unknown as ExtensionContext;

  await tool.execute(
    'call',
    {
      sourceTaskId: 'source',
      task: 'Follow up.',
      timeoutSeconds: 10,
      settingsUnchanged: true,
      visibility: 'background',
    },
    undefined,
    undefined,
    context,
  );

  expect(tool.parameters).toHaveProperty('properties.visibility');
  expect(followUp).toHaveBeenCalledWith(
    expect.objectContaining({ visibility: 'background' }),
    context,
    undefined,
  );
  expect(followUp.mock.calls[0]?.[0]).not.toHaveProperty('parentPane');
});

it('routes approved native tool arguments through the generic resolver without Pi guarantees', async ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-native-tool-'));
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'parent');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');
  const tools = new Map<string, ToolDefinition>();
  subagentsExtension({
    events: createEventBus(),
    on: () => undefined,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI);
  const launch = vi
    .spyOn(WorkerController.prototype, 'launch')
    .mockResolvedValue({} as Awaited<ReturnType<WorkerController['launch']>>);
  vi.spyOn(WorkerController.prototype, 'parentAuthority').mockResolvedValue({
    tree: {
      rootSession: join(directory, 'parent.jsonl'),
      rootSessionId: 'parent',
      monotonicDeadline: Number.MAX_SAFE_INTEGER,
    },
  });
  const confirm = vi.fn<ExtensionContext['ui']['confirm']>().mockResolvedValue(true);
  const context = {
    cwd: directory,
    isProjectTrusted: () => true,
    hasUI: true,
    ui: { confirm },
    sessionManager: {
      getSessionFile: () => join(directory, 'parent.jsonl'),
      getSessionId: () => 'parent',
    },
  } as unknown as ExtensionContext;
  const input = {
    profile: 'worker',
    harness: 'gemini',
    permissions: 'native-controls',
    nativeArguments: ['--native-setting', 'literal value'],
    reportDirectory: directory,
    task: 'Inspect fixture.',
    timeoutSeconds: 10,
  };
  const tool = tools.get('subagent');
  const reply = tools.get('subagent_reply');
  if (!tool || !reply) {
    throw new Error('Worker tools missing.');
  }

  expect(Value.Check(tool.parameters, input)).toBe(true);
  expect(
    Value.Check(reply.parameters, {
      taskId: 'task',
      replyId: 'reply',
      reply: 'Scoped text.',
      scopeUnchanged: true,
    }),
  ).toBe(true);
  await tool.execute('native-call', input, undefined, undefined, context);

  expect(confirm).toHaveBeenCalledTimes(1);
  expect(launch.mock.calls[0]?.[0].loadout).toMatchObject({
    harness: 'generic',
    kind: 'gemini',
    permissions: 'native-controls',
    arguments: input.nativeArguments,
    reportDirectory: directory,
    configurationApproved: true,
  });
  expect(launch.mock.calls[0]?.[0].loadout).not.toHaveProperty('safetyExtension');
  await expect(
    tool.execute(
      'unsupported-guarantee',
      { ...input, permissions: 'trusted-full-tools' },
      undefined,
      undefined,
      context,
    ),
  ).rejects.toThrow('native-controls');
  await expect(
    tool.execute('unattended', input, undefined, undefined, { ...context, hasUI: false }),
  ).rejects.toThrow('No unattended approval');
  vi.stubEnv('HERDR_ENV', '0');
  await expect(tool.execute('outside-herdr', input, undefined, undefined, context)).rejects.toThrow(
    'inside local herdr',
  );
  expect(launch).toHaveBeenCalledTimes(1);
});
