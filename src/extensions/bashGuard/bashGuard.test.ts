import { expect, it } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import bashGuard from './bashGuard.js';

const nohupClose =
  'nohup sh -c \'sleep 30; herdr-app do space.close --id sp527dd22aa065042833adf82c857c6cab --confirmed\' >/dev/null 2>&1 & echo "close scheduled"';

const loggedClose =
  "setsid sh -c 'sleep 25; herdr-app do space.close --id sp527dd22aa065042833adf82c857c6cab --confirmed true > /tmp/tau-space-close.log 2>&1' </dev/null >/dev/null 2>&1 &";

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
