import { expect, it } from 'vitest';

import { loggedClose, nohupClose } from '../../../tests/bashGuardCommands.js';
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

  const reason =
    typeof result === 'object' && result !== null && 'reason' in result ? result.reason : undefined;

  expect(reason).toContain('/tmp/<name>.log');
});

it('allows a detached setsid command whose effect writes a log', async () => {
  expect(await toolCall(loggedClose)).toBeUndefined();
});
