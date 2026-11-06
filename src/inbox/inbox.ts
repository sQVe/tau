import { ensurePrivateDirectory, openEndpoint, socketPathFor } from './endpoint.js';
import type { Endpoint } from './endpoint.js';
import { decodeRequest, encodeFrame, refusedReply } from './protocol.js';
import type { MessageReply, MessageRequest } from './protocol.js';

export { socketDirectoryFor } from './endpoint.js';
export { formatInboxLabel, inboxLabelKey } from './protocol.js';
export { createReceiver } from './receive.js';
export type { Receiver } from './receive.js';
export { createReceiptStore } from './receipts.js';
export { sendInboxMessage } from './send.js';
export type { InboxSendRequest, InboxSendResult } from './send.js';

export interface InboxStartOptions {
  sessionId: string;
  terminal: string;
  directory: string;
  // Saves a message addressed to this inbox and returns the reply.
  accept: (request: MessageRequest) => Promise<MessageReply>;
  // Called after a message was queued, so the receiver can drain it.
  onQueued: () => void;
  // Publish and remove the terminal's advertisement. They run inside the start and stop
  // transitions, so a withdrawal never interleaves with a replacement's advertisement.
  advertise: (path: string) => Promise<void>;
  withdraw: (path: string) => Promise<void>;
}

export interface InboxListener {
  stop: () => Promise<void>;
}

interface InboxSlot {
  endpoint: Endpoint | undefined;
  transition: Promise<unknown>;
}

declare global {
  var tauInboxSlot: InboxSlot | undefined;
}

// Pi imports an extension again on reload, and a worker loads its own extension file, so module
// state is not shared. The listener lives in one process-wide slot instead.
const slot: InboxSlot = globalThis.tauInboxSlot ?? {
  endpoint: undefined,
  transition: Promise.resolve(),
};

globalThis.tauInboxSlot = slot;

// Runs start and stop one at a time, so a replacement binds only after the earlier one closed.
const serialize = <T>(work: () => Promise<T>): Promise<T> => {
  const next = slot.transition.then(work, work);

  slot.transition = next.catch(() => undefined);

  return next;
};

const targetsInbox = (request: MessageRequest, options: InboxStartOptions): boolean =>
  request.targetTerminal === options.terminal && request.targetSessionId === options.sessionId;

const answerFrame = async (bytes: Buffer, options: InboxStartOptions) => {
  const decision = decodeRequest(bytes);

  if (decision.kind === 'refused') {
    return refusedReply(decision.reason);
  }

  const request = decision.value;

  if (!targetsInbox(request, options)) {
    return refusedReply(
      `This inbox is terminal ${options.terminal}, session ${options.sessionId}.`,
      request.messageId,
    );
  }

  const reply = await options.accept(request);

  if (reply.kind === 'queued') {
    options.onQueued();
  }

  return reply;
};

const closeCurrent = async (): Promise<void> => {
  const current = slot.endpoint;

  slot.endpoint = undefined;
  await current?.close();
};

const open = async (options: InboxStartOptions): Promise<InboxListener> => {
  await closeCurrent();

  ensurePrivateDirectory(options.directory);

  const path = socketPathFor(options.directory, options.sessionId);

  const endpoint = await openEndpoint({
    path,
    respond: async (bytes) => encodeFrame(await answerFrame(bytes, options)),
  });

  slot.endpoint = endpoint;

  try {
    await options.advertise(path);
  } catch (error) {
    await closeCurrent();

    throw error;
  }

  return {
    stop: () =>
      serialize(async () => {
        if (slot.endpoint !== endpoint) {
          await endpoint.close();

          return;
        }

        await closeCurrent();
        await options.withdraw(path);
      }),
  };
};

// Closes an earlier listener first, also when no shutdown ran between two session starts.
export const startInbox = (options: InboxStartOptions): Promise<InboxListener> =>
  serialize(() => open(options));
