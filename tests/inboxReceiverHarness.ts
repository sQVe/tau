import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { onTestFinished } from 'vitest';

import { createReceiptStore, createReceiver, startInbox } from '../src/inbox/inbox.js';

export interface HandoverReceiver {
  sessionId: string;
  // The socket path a `tau.inbox` label names.
  path: string;
  // Paths of saved records, relative to the record root.
  savedRecords: () => string[];
}

// Starts a real inbox for terminal `terminal` that saves handovers below `root` and shows nothing.
// `root` must be a private directory with a short path, because it holds the socket.
export const startHandoverReceiver = async (
  finished: typeof onTestFinished,
  root: string,
  terminal: string,
): Promise<HandoverReceiver> => {
  const sessionId = randomUUID();
  const records = join(root, 'records');
  const paths: string[] = [];

  const receiver = createReceiver({
    directory: join(records, sessionId),
    terminal,
    sessionId,
    accepts: { handover: () => undefined },
    receipts: createReceiptStore(sessionId),
    entries: () => [],
    wake: () => undefined,
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
