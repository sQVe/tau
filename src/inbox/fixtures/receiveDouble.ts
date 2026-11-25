import { join } from 'node:path';

import type { MessageReply } from '../protocol.js';
import type { ReceiptEntryFact } from '../receiptDecision.js';
import { createReceiptStore } from '../receipts.js';
import { createReceiver } from '../receive.js';
import type { Receiver, ReceiverOptions } from '../receive.js';

export const queuedReply = (sessionId: string, messageId: string): MessageReply => ({
  protocol: 'rpc1',
  kind: 'queued',
  messageId,
  terminal: 't7',
  sessionId,
});

export const savedRecordPath = (directory: string, sessionId: string, messageId: string): string =>
  join(directory, 'records', sessionId, `${messageId}.json`);

export const startReceiveDouble = (
  directory: string,
  sessionId: string,
  accepts: ReceiverOptions['accepts'],
  holds = 0,
  entries: () => readonly ReceiptEntryFact[] = () => [],
): { receiver: Receiver; woken: unknown[] } => {
  const woken: unknown[] = [];
  let heldWakes = holds;

  const receiver = createReceiver({
    directory: join(directory, 'records', sessionId),
    terminal: 't7',
    sessionId,
    accepts,
    receipts: createReceiptStore(sessionId),
    entries,
    wake: (message) => {
      if (heldWakes > 0) {
        heldWakes -= 1;

        return false;
      }

      woken.push(message);

      return true;
    },
    notify: () => undefined,
  });

  return { receiver, woken };
};
