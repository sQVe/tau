import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fauxProvider } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import {
  WorkerCapacityFullError,
  WorkerController,
} from '../src/extensions/subagents/controller/controller.js';
import tauExtension from '../src/tau.js';
import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';
import { createBoundSession } from './piSession.js';

it('terminates a raw git commit call after Tau refuses worker capacity', async ({
  onTestFinished,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-capacity-'));

  onTestFinished(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  isolateWebAccessConfig(directory, onTestFinished);
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'parent');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');
  vi.spyOn(WorkerController.prototype, 'resume').mockResolvedValue(undefined);

  const refusal = new WorkerCapacityFullError('Worker capacity full');
  vi.spyOn(WorkerController.prototype, 'followUp').mockRejectedValue(refusal);

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [fauxProvider({ provider: 'tau-capacity-test' })],
    sessionManager: SessionManager.create(directory),
    extensionFactories: [tauExtension],
  });

  const runner = session.extensionRunner;
  const tool = runner.getToolDefinition('subagent_follow_up');

  if (!tool) {
    throw new Error('Missing follow-up tool.');
  }

  const call = {
    type: 'tool_call' as const,
    toolCallId: 'commit-call',
    toolName: 'bash' as const,
    input: { command: 'git commit -m "feat: bypass guard"' },
  };

  const beforeRefusal = await runner.emitToolCall(call);

  expect(beforeRefusal).toMatchObject({ block: true });
  expect(beforeRefusal?.terminate).not.toBe(true);

  const result = await tool.execute(
    'follow-up',
    { sourceTaskId: 'source', task: 'Continue.', timeoutSeconds: 10 },
    undefined,
    undefined,
    runner.createToolContext('follow-up', undefined),
  );

  expect(result).toMatchObject({ isError: true, terminate: true });

  await expect(runner.emitToolCall(call)).resolves.toMatchObject({
    block: true,
    terminate: true,
  });
});
