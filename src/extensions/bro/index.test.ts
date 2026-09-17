import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import broExtension from './index.js';

type Command = Parameters<ExtensionAPI['registerCommand']>[1];

describe('broExtension', () => {
  it('sends skill messages as follow-ups when idle and steering messages when busy', async () => {
    const registeredCommands = new Map<string, Command>();
    const sentUserMessages: unknown[] = [];
    const fakePi = {
      registerCommand: (name: string, command: Command) => registeredCommands.set(name, command),
      sendUserMessage: (content: string, options: unknown) =>
        sentUserMessages.push({ content, options }),
    } as unknown as ExtensionAPI;

    broExtension(fakePi);

    const broCommand = registeredCommands.get('bro');

    if (broCommand == null) {
      throw new Error('Expected bro command to be registered');
    }

    await broCommand.handler('the test failure', { isIdle: () => true } as never);
    await broCommand.handler('', { isIdle: () => true } as never);
    await broCommand.handler('', { isIdle: () => false } as never);

    expect(sentUserMessages).toEqual([
      { content: '/skill:bro the test failure', options: { deliverAs: 'followUp' } },
      { content: '/skill:bro', options: { deliverAs: 'followUp' } },
      { content: '/skill:bro', options: { deliverAs: 'steer' } },
    ]);
  });
});
