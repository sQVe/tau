import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { onTestFinished } from 'vitest';

import { createReceiptStore, createReceiver, startInbox } from '../src/inbox/inbox.js';
import type { ReceiverOptions } from '../src/inbox/inbox.js';
import type { Family } from '../src/inbox/protocol.js';

export interface HandoverReceiver {
  sessionId: string;
  path: string;
  savedRecords: () => string[];
}

export interface HandoverReceiverOptions {
  accepts?: ReceiverOptions['accepts'];
  sessionId?: string;
}

const acceptHandovers: ReceiverOptions['accepts'] = { handover: (_request, save) => save() };

export const startHandoverReceiver = async (
  finished: typeof onTestFinished,
  root: string,
  terminal: string,
  options: HandoverReceiverOptions = {},
): Promise<HandoverReceiver> => {
  const { accepts = acceptHandovers, sessionId = randomUUID() } = options;
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

// Accept checks live in the process-wide inbox slot, so a test that registers one removes it after.
export const forgetAcceptCheck = (family: Family): void => {
  const slot = globalThis.tauInboxSlot;

  if (slot !== undefined) {
    const remaining = Object.entries(slot.checks).filter(([name]) => name !== family);

    slot.checks = Object.fromEntries(remaining);
  }
};
