import { ensurePrivateDirectory, openEndpoint, socketPathFor } from './endpoint.js';
import type { Endpoint } from './endpoint.js';
import { decodeRequest, encodeFrame, families, refusedReply } from './protocol.js';
import type { Family, MessageReply, MessageRequest, Reply } from './protocol.js';

export { socketDirectoryFor } from './endpoint.js';
export { formatInboxLabel, inboxLabelKey } from './protocol.js';
export { createHandoverReceiver } from './receive.js';
export { createReceiptStore } from './receipts.js';
export { sendInboxMessage } from './send.js';
export type { InboxSendRequest, InboxSendResult } from './send.js';

export interface InboxStartOptions {
  sessionId: string;
  terminal: string;
  directory: string;
  // Called after a handler queued a message, so the receiver can drain it.
  onQueued: () => void;
  // Publish and remove the terminal's advertisement. They run inside the start and stop
  // transitions, so a withdrawal never interleaves with a replacement's advertisement.
  advertise: (path: string) => Promise<void>;
  withdraw: (path: string) => Promise<void>;
}

export interface InboxListener {
  stop: () => Promise<void>;
}

// A family handler has two steps. `accept` validates and publishes a request, then returns the
// reply the socket sends; it never waits on the startup gate. `deliver` runs later from the
// receiver's drain, with the signal of the session generation that requested it.
export interface FamilyHandler {
  accept: (request: MessageRequest) => Promise<MessageReply>;
  deliver: (signal: AbortSignal) => Promise<void>;
}

interface Registration {
  sessionId: string;
  family: Family;
  handler: FamilyHandler;
}

interface OpenListener {
  sessionId: string;
  terminal: string;
  endpoint: Endpoint;
}

interface InboxSlot {
  listener: OpenListener | undefined;
  transition: Promise<unknown>;
  registrations: Registration[];
}

declare global {
  var tauInboxSlot: InboxSlot | undefined;
}

// Pi imports an extension again on reload, and a worker loads its own extension file, so module
// state is not shared. The listener and handlers live in one process-wide slot instead.
const slot: InboxSlot = globalThis.tauInboxSlot ?? {
  listener: undefined,
  transition: Promise.resolve(),
  registrations: [],
};

globalThis.tauInboxSlot = slot;

// Runs start and stop one at a time, so a replacement binds only after the earlier one closed.
const serialize = <T>(work: () => Promise<T>): Promise<T> => {
  const next = slot.transition.then(work, work);

  slot.transition = next.catch(() => undefined);

  return next;
};

const registrationFor = (sessionId: string, family: Family): Registration | undefined =>
  slot.registrations.findLast(
    (registration) => registration.sessionId === sessionId && registration.family === family,
  );

// The latest registration wins, and a disposer removes only its own entry.
export const registerFamilyHandler = (
  sessionId: string,
  family: Family,
  handler: FamilyHandler,
): (() => void) => {
  const registration: Registration = { sessionId, family, handler };

  slot.registrations.push(registration);

  return () => {
    slot.registrations = slot.registrations.filter((entry) => entry !== registration);
  };
};

export const familyHandlers = (sessionId: string): FamilyHandler[] =>
  families.flatMap((family) => registrationFor(sessionId, family)?.handler ?? []);

const availableFamilies = (sessionId: string): Family[] =>
  families.filter((family) => registrationFor(sessionId, family) !== undefined);

const targetsListener = (request: MessageRequest, listener: OpenListener): boolean =>
  request.targetTerminal === listener.terminal && request.targetSessionId === listener.sessionId;

const answerMessage = async (
  request: MessageRequest,
  listener: OpenListener,
  onQueued: () => void,
): Promise<MessageReply> => {
  if (!targetsListener(request, listener)) {
    return refusedReply(
      `This inbox is terminal ${listener.terminal}, session ${listener.sessionId}.`,
      request.messageId,
    );
  }

  const registration = registrationFor(listener.sessionId, request.family);

  if (registration === undefined) {
    return refusedReply(
      `This session does not accept ${request.family} messages.`,
      request.messageId,
    );
  }

  const reply = await registration.handler.accept(request);

  if (reply.kind === 'queued') {
    onQueued();
  }

  return reply;
};

const answerFrame = async (
  bytes: Buffer,
  listener: OpenListener,
  onQueued: () => void,
): Promise<Reply> => {
  const decision = decodeRequest(bytes);

  if (decision.kind === 'refused') {
    return refusedReply(decision.reason);
  }

  const request = decision.value;

  if (request.kind === 'hello') {
    return {
      protocol: request.protocol,
      kind: 'ready',
      terminal: listener.terminal,
      sessionId: listener.sessionId,
      families: availableFamilies(listener.sessionId),
    };
  }

  return answerMessage(request, listener, onQueued);
};

const closeCurrent = async (): Promise<void> => {
  const current = slot.listener;

  slot.listener = undefined;
  await current?.endpoint.close();
};

const open = async (options: InboxStartOptions): Promise<InboxListener> => {
  await closeCurrent();

  ensurePrivateDirectory(options.directory);

  const path = socketPathFor(options.directory, options.sessionId);
  const pending: { listener?: OpenListener } = {};

  const endpoint = await openEndpoint({
    path,
    respond: async (bytes) => {
      const { listener } = pending;

      const reply =
        listener === undefined
          ? refusedReply('The inbox is starting.')
          : await answerFrame(bytes, listener, options.onQueued);

      return encodeFrame(reply);
    },
  });

  const listener: OpenListener = {
    sessionId: options.sessionId,
    terminal: options.terminal,
    endpoint,
  };

  pending.listener = listener;
  slot.listener = listener;

  try {
    await options.advertise(path);
  } catch (error) {
    await closeCurrent();

    throw error;
  }

  return {
    stop: () =>
      serialize(async () => {
        if (slot.listener !== listener) {
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
