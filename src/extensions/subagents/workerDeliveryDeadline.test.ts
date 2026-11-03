import { randomUUID } from 'node:crypto';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { createWorkerDelivery } from './workerDelivery.js';

interface SentMessage {
  customType?: unknown;
  display?: unknown;
  details?: unknown;
}

const createManagerSession = () => {
  const messages: SentMessage[] = [];
  const entries: unknown[] = [];

  const pi = {
    on: () => undefined,
    sendMessage: (message: SentMessage) => {
      messages.push(message);

      entries.push({
        type: 'custom_message',
        customType: message.customType,
        details: message.details,
      });
    },
  } as unknown as ExtensionAPI;

  const context = {
    sessionManager: { getEntries: () => entries },
    ui: { notify: () => undefined },
    isIdle: () => true,
    signal: undefined,
  } as unknown as Parameters<ReturnType<typeof createWorkerDelivery>['showEnded']>[0];

  return { pi, context, messages, entries };
};

it('shows one ended-at-deadline message per assignment', () => {
  const assignmentId = randomUUID();
  const { pi, context, messages, entries } = createManagerSession();
  const delivery = createWorkerDelivery(pi);

  delivery.showEnded(context, assignmentId);
  delivery.showEnded(context, assignmentId);

  expect(messages).toHaveLength(1);

  expect(messages[0]).toMatchObject({
    customType: 'tau-worker-deadline',
    display: true,
    details: { assignmentId },
  });

  expect(entries).toEqual([
    {
      type: 'custom_message',
      customType: 'tau-worker-deadline',
      details: { assignmentId },
    },
  ]);
});

it('restores the ended-at-deadline message from the saved session', () => {
  const assignmentId = randomUUID();
  const { pi, context, messages, entries } = createManagerSession();

  entries.push({
    type: 'custom_message',
    customType: 'tau-worker-deadline',
    details: { assignmentId },
  });

  createWorkerDelivery(pi).showEnded(context, assignmentId);

  expect(messages).toEqual([]);
});
