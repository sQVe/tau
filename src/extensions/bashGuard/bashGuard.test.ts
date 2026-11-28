import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { blockedOutputReason, loggedClose, nohupClose } from '../../../tests/bashGuardCommands.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import bashGuard from './bashGuard.js';
import { blockReason } from './detachedOutputDecision.js';

const toolCall = async (command: string): Promise<unknown> => {
  const fake = fakeExtensionApi();

  const event: ToolCallEvent = {
    type: 'tool_call',
    toolCallId: 'tool-call-1',
    toolName: 'bash',
    input: { command },
  };

  bashGuard(fake.pi);

  return fake.handler('tool_call')(event, {} as never);
};

it('blocks a detached nohup command that discards its stderr', async () => {
  const result = await toolCall(nohupClose);

  expect(result).toMatchObject({ block: true });
  expect(blockedOutputReason(result)).toBe(blockReason);
});

it('allows a detached setsid command whose effect writes a log', async () => {
  expect(await toolCall(loggedClose)).toBeUndefined();
});

it('ignores a tool call that is not bash', async () => {
  const fake = fakeExtensionApi();

  bashGuard(fake.pi);

  const event: ToolCallEvent = {
    type: 'tool_call',
    toolCallId: 'tool-call-2',
    toolName: 'read',
    input: { path: '/tmp/file' },
  };

  const result = await fake.handler('tool_call')(event, {} as never);

  expect(result).toBeUndefined();
});
