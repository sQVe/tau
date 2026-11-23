import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { onTestFinished } from 'vitest';

import { ensurePrivateDirectory, openEndpoint, socketPathFor } from '../src/inbox/endpoint.js';
import { createReceiptStore, createReceiver, startInbox } from '../src/inbox/inbox.js';
import type { ReceiverOptions } from '../src/inbox/inbox.js';
import {
  decodeRequest,
  encodeFrame,
  formatInboxLabel,
  refusedReply,
} from '../src/inbox/protocol.js';
import type { Family, MessageReply, MessageRequest } from '../src/inbox/protocol.js';
import { pendingMessages, readMessage } from '../src/inbox/store.js';
import type { HcFake } from './hcFake.js';

export interface HandoverReceiver {
  sessionId: string;
  path: string;
  // The folder that holds this receiver's saved records.
  inbox: string;
  savedRecords: () => string[];
}

export interface HandoverReceiverOptions {
  accepts?: ReceiverOptions['accepts'];
  sessionId?: string;
  // The process has one inbox slot. A receiver outside it leaves the slot to another receiver.
  outsideSlot?: boolean;
  beforeCommit?: ReceiverOptions['beforeCommit'];
  beforePublish?: ReceiverOptions['beforePublish'];
}

type Accept = (request: MessageRequest) => Promise<MessageReply>;

export const advertiseInbox = (
  hc: Pick<HcFake, 'replyGet'>,
  terminal: string,
  path: string,
): void => {
  hc.replyGet(
    terminal,
    JSON.stringify({
      address: terminal,
      name: null,
      state: 'live',
      labels: { 'tau.inbox': formatInboxLabel(path) },
    }),
  );
};

const acceptHandovers: ReceiverOptions['accepts'] = { handover: (_request, save) => save() };

const listenInSlot = async (
  directory: string,
  sessionId: string,
  terminal: string,
  accept: Accept,
  paths: string[],
): Promise<() => Promise<void>> => {
  const listener = await startInbox({
    sessionId,
    terminal,
    directory,
    accept,
    onQueued: () => undefined,
    advertise: (path) => {
      paths.push(path);

      return Promise.resolve();
    },
    withdraw: () => Promise.resolve(),
  });

  return listener.stop;
};

const listenOutsideSlot = async (
  directory: string,
  sessionId: string,
  accept: Accept,
  paths: string[],
): Promise<() => Promise<void>> => {
  ensurePrivateDirectory(directory);

  const endpoint = await openEndpoint({
    path: socketPathFor(directory, sessionId),
    respond: async (bytes) => {
      const decision = decodeRequest(bytes);

      const reply =
        decision.kind === 'frame' ? await accept(decision.value) : refusedReply(decision.reason);

      return encodeFrame(reply);
    },
  });

  paths.push(endpoint.path);

  return () => endpoint.close();
};

export const startHandoverReceiver = async (
  finished: typeof onTestFinished,
  root: string,
  terminal: string,
  options: HandoverReceiverOptions = {},
): Promise<HandoverReceiver> => {
  const { accepts = acceptHandovers, sessionId = randomUUID() } = options;
  const records = join(root, 'records');
  const inbox = join(records, sessionId);
  const paths: string[] = [];

  const receiver = createReceiver({
    directory: inbox,
    terminal,
    sessionId,
    accepts,
    receipts: createReceiptStore(sessionId),
    entries: () => [],
    wake: () => true,
    notify: () => undefined,
    ...(options.beforeCommit === undefined ? {} : { beforeCommit: options.beforeCommit }),
    ...(options.beforePublish === undefined ? {} : { beforePublish: options.beforePublish }),
  });

  const directory = join(root, 'sockets');

  const stop =
    options.outsideSlot === true
      ? await listenOutsideSlot(directory, sessionId, receiver.accept, paths)
      : await listenInSlot(directory, sessionId, terminal, receiver.accept, paths);

  finished(stop);

  const savedRecords = (): string[] => {
    try {
      return readdirSync(records, { recursive: true }).map(String);
    } catch {
      return [];
    }
  };

  return { sessionId, path: paths[0] ?? '', inbox, savedRecords };
};

const savedText = async (directory: string, messageId: string): Promise<string> => {
  const read = await readMessage(directory, messageId);

  if (read.kind !== 'record') {
    throw new Error(`Inbox record ${messageId} is ${read.kind}.`);
  }

  if (read.record.family !== 'handover') {
    throw new Error(
      `Inbox record ${messageId} is a ${read.record.family} message, not a handover.`,
    );
  }

  return read.record.payload.text;
};

export const savedTextsIn = async (directory: string): Promise<string[]> => {
  const messageIds = await pendingMessages(directory);

  return Promise.all(messageIds.map((messageId) => savedText(directory, messageId)));
};

export const savedTexts = async (receiver: HandoverReceiver): Promise<string[]> =>
  savedTextsIn(receiver.inbox);

export const savedFiles = (receiver: HandoverReceiver): string[] =>
  receiver.savedRecords().filter((name) => name.startsWith(`${receiver.sessionId}/`));

// Accept checks live in the process-wide inbox slot, so a test that registers one removes it after.
export const forgetAcceptCheck = (family: Family): void => {
  const slot = globalThis.tauInboxSlot;

  if (slot !== undefined) {
    const remaining = Object.entries(slot.checks).filter(([name]) => name !== family);

    slot.checks = Object.fromEntries(remaining);
  }
};
