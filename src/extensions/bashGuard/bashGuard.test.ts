import { expect, it } from 'vitest';

import { blockedOutputReason, loggedClose, nohupClose } from '../../../tests/bashGuardCommands.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import bashGuard from './bashGuard.js';

const toolCall = async (command: string): Promise<unknown> => {
  const fake = fakeExtensionApi();

  bashGuard(fake.pi);

  return fake.handler('tool_call')({ toolName: 'bash', input: { command } }, {} as never);
};

it('blocks a detached nohup command that discards its stderr', async () => {
  const result = await toolCall(nohupClose);

  expect(result).toMatchObject({ block: true });
  expect(blockedOutputReason(result)).toBeDefined();
});

it('allows a detached setsid command whose effect writes a log', async () => {
  expect(await toolCall(loggedClose)).toBeUndefined();
});

it('ignores a tool call that is not bash', async () => {
  const fake = fakeExtensionApi();

  bashGuard(fake.pi);

  const result = await fake.handler('tool_call')(
    { toolName: 'read', input: { path: '/tmp/file' } },
    {} as never,
  );

  expect(result).toBeUndefined();
});
