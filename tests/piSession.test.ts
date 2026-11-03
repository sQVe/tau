import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { shutdownSession } from './piSession.js';

it('emits session_shutdown before disposing the session', async () => {
  const order: string[] = [];

  const session = {
    extensionRunner: {
      emit: (event: unknown) => {
        order.push(`emit:${(event as { reason: string }).reason}`);

        return Promise.resolve({});
      },
    },
    dispose: () => {
      order.push('dispose');
    },
  } as unknown as AgentSession;

  await shutdownSession(session);

  expect(order).toEqual(['emit:quit', 'dispose']);
});
