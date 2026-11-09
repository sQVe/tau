import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { onTestFinished } from 'vitest';

import { createReceiptStore, createReceiver, startInbox } from '../src/inbox/inbox.js';
import type { ReceiverOptions } from '../src/inbox/inbox.js';

export interface HandoverReceiver {
  sessionId: string;
  path: string;
  savedRecords: () => string[];
}

const acceptHandovers: ReceiverOptions['accepts'] = { handover: (_request, save) => save() };

export const startHandoverReceiver = async (
  finished: typeof onTestFinished,
  root: string,
  terminal: string,
  accepts = acceptHandovers,
): Promise<HandoverReceiver> => {
  const sessionId = randomUUID();
  const records = join(root, 'records');
  const paths: string[] = [];

  const receiver = createReceiver({
    directory: join(records, sessionId),
    terminal,
    sessionId,
    accepts,
    receipts: createReceiptStore(sessionId),
    entries: () => [],
    wake: () => true,
    notify: () => undefined,
  });

  const listener = await startInbox({
    sessionId,
    terminal,
    directory: join(root, 'sockets'),
    accept: receiver.accept,
    onQueued: () => undefined,
    advertise: (path) => {
      paths.push(path);

      return Promise.resolve();
    },
    withdraw: () => Promise.resolve(),
  });

  finished(async () => {
    await listener.stop();
  });

  const savedRecords = (): string[] => {
    try {
      return readdirSync(records, { recursive: true }).map(String);
    } catch {
      return [];
    }
  };

  return { sessionId, path: paths[0] ?? '', savedRecords };
};
