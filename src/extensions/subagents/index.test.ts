import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createEventBus } from '@earendil-works/pi-coding-agent';
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
