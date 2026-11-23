import { ensurePrivateDirectory, openEndpoint, socketPathFor } from './endpoint.js';
import type { Endpoint } from './endpoint.js';
import { decodeRequest, encodeFrame, refusedReply } from './protocol.js';
import type { Family, MessageReply, MessageRequest } from './protocol.js';
import type { AcceptCheck } from './receive.js';

export { socketDirectoryFor } from './endpoint.js';

export {
  encodeMessageFrame,
  inboxLabelKey,
  isUuid,
  requestByteLimit,
  uuidSchema,
} from './protocol.js';

export type { MessageRequest } from './protocol.js';
export { advertiseLabel, withdrawLabel } from './label.js';
export { createReceiver } from './receive.js';
export type { AcceptCheck, Receiver, ReceiverOptions } from './receive.js';
export { createReceiptStore } from './receipts.js';
export { sendInboxMessage } from './send.js';
export { ownInboxReady } from './targetDecision.js';
export type { InboxSendRequest, InboxSendResult } from './send.js';

export interface InboxStartOptions {
  sessionId: string;
  terminal: string;
  directory: string;
  accept: (request: MessageRequest) => Promise<MessageReply>;
  onQueued: () => void;
  advertise: (path: string) => Promise<void>;
  withdraw: (path: string) => Promise<void>;
}

export interface InboxListener {
  stop: () => Promise<void>;
}

interface InboxSlot {
  endpoint: Endpoint | undefined;
  transition: Promise<unknown>;
  checks: Partial<Record<Family, AcceptCheck>>;
  owner: symbol | undefined;
}

declare global {
  var tauInboxSlot: InboxSlot | undefined;
}

// Pi imports an extension again on reload, and a worker loads its own extension file, so module
// state is not shared. The listener lives in one process-wide slot instead. A session claims the
// slot when it starts, because Pi can load a copy and discard it before any session starts.
const slot: InboxSlot = globalThis.tauInboxSlot ?? {
  endpoint: undefined,
  transition: Promise.resolve(),
  checks: {},
  owner: undefined,
};

globalThis.tauInboxSlot = slot;

export const setAcceptCheck = (family: Family, check: AcceptCheck): void => {
  slot.checks[family] = check;
};

export const currentInboxPath = (): string | undefined => slot.endpoint?.path;

export const acceptChecks = (): Partial<Record<Family, AcceptCheck>> => slot.checks;

export const claimInbox = (owner: symbol): boolean => {
  if (slot.owner === undefined || slot.owner === owner) {
    slot.owner = owner;

    return true;
  }

  return false;
};

export const holdsInbox = (owner: symbol): boolean => slot.owner === owner;

export const releaseInbox = (owner: symbol): void => {
  if (slot.owner === owner) {
    slot.owner = undefined;
  }
};

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

const closeCurrent = async (beforeUnlink?: () => Promise<void>): Promise<void> => {
  const current = slot.endpoint;

  slot.endpoint = undefined;
  await current?.close(beforeUnlink);
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
    // The label may be set even when its reply failed. The advertise error explains the failure.
    await closeCurrent(() => options.withdraw(path).catch(() => undefined));

    throw error;
  }

  return {
    stop: () =>
      serialize(async () => {
        if (slot.endpoint !== endpoint) {
          await endpoint.close();

          return;
        }

        await closeCurrent(() => options.withdraw(path));
      }),
  };
};

export const startInbox = (options: InboxStartOptions): Promise<InboxListener> =>
  serialize(() => open(options));
