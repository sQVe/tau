import type { Family, MessageBody, MessageReply, MessageRequest } from './protocol.js';
import { refusedReply } from './protocol.js';
import { decideCandidate, inboxMessageType, inboxReceiptVersion } from './receiptDecision.js';
import type { ReceiptEntryFact } from './receiptDecision.js';
import type { ReceiptStore } from './receipts.js';
import { deleteMessage, pendingMessages, readMessage, saveMessage } from './store.js';

interface InboxMessage {
  customType: string;
  content: string;
  display: boolean;
  details: unknown;
}

// Returns why a message is refused before it is saved, or undefined to accept it.
type AcceptCheck = (body: MessageBody) => string | undefined;

export interface ReceiverOptions {
  // The session's own record directory.
  directory: string;
  terminal: string;
  sessionId: string;
  // The families this session accepts; a message of any other family is refused.
  accepts: Partial<Record<Family, AcceptCheck>>;
  receipts: ReceiptStore;
  entries: () => readonly ReceiptEntryFact[];
  wake: (message: InboxMessage) => void;
  notify: (message: string) => void;
}

// `accept` saves a request and returns the reply the socket sends; it never waits on the startup
// gate. `deliver` runs later from the drain, with the signal of the generation that requested it.
export interface Receiver {
  accept: (request: MessageRequest) => Promise<MessageReply>;
  deliver: (signal: AbortSignal) => Promise<void>;
}

const queuedReply = (options: ReceiverOptions, messageId: string): MessageReply => ({
  protocol: 'rpc1',
  kind: 'queued',
  messageId,
  terminal: options.terminal,
  sessionId: options.sessionId,
});

// Narrowing on the family keeps each payload paired with its own family.
const bodyOf = (request: MessageRequest): MessageBody =>
  request.family === 'handover'
    ? { family: 'handover', payload: request.payload }
    : { family: 'answer', payload: request.payload };

const accept = async (options: ReceiverOptions, request: MessageRequest): Promise<MessageReply> => {
  const { messageId, family } = request;
  const check = options.accepts[family];

  if (check === undefined) {
    return refusedReply(`This session does not accept ${family} messages.`, messageId);
  }

  options.receipts.restore(options.entries());

  // A receipted message was shown already, and its record may be gone, so a retry must not save
  // it again.
  if (options.receipts.hasReceipt(messageId)) {
    return queuedReply(options, messageId);
  }

  const body = bodyOf(request);
  const refusal = check(body);

  if (refusal !== undefined) {
    return refusedReply(refusal, messageId);
  }

  const outcome = await saveMessage(options.directory, { version: 1, messageId, ...body });

  if (outcome === 'changed') {
    return refusedReply(`Message ${messageId} is already saved with different content.`, messageId);
  }

  return queuedReply(options, messageId);
};

const messageText = (body: MessageBody): string =>
  body.family === 'handover' ? body.payload.text : body.payload.answer;

const wakeOnce = (options: ReceiverOptions, messageId: string, body: MessageBody): void => {
  options.receipts.markQueued(messageId);

  try {
    options.wake({
      customType: inboxMessageType,
      content: messageText(body),
      display: true,
      details: {
        version: inboxReceiptVersion,
        messageId,
        sessionId: options.sessionId,
        family: body.family,
      },
    });
  } catch (error) {
    options.receipts.clearQueued(messageId);

    throw error;
  }
};

const deliverOne = async (
  options: ReceiverOptions,
  messageId: string,
  reported: Set<string>,
  signal: AbortSignal,
): Promise<void> => {
  const { receipts, directory } = options;

  const step = decideCandidate({
    hasOwnReceipt: receipts.hasReceipt(messageId),
    queued: receipts.isQueued(messageId),
  });

  if (step === 'cleanup') {
    await deleteMessage(directory, messageId);

    return;
  }

  if (step === 'pending') {
    return;
  }

  const read = await readMessage(directory, messageId);

  // A replacement generation owns delivery once this one ended during the read.
  if (signal.aborted || read.kind === 'missing') {
    return;
  }

  if (read.kind === 'malformed') {
    if (!reported.has(messageId)) {
      reported.add(messageId);
      options.notify(`Tau inbox skipped message ${messageId}: ${read.reason}`);
    }

    return;
  }

  wakeOnce(options, messageId, read.record);
};

// Accepting saves the record and replies; delivery shows each saved record once and deletes it only
// after Pi saved its receipt.
export const createReceiver = (options: ReceiverOptions): Receiver => {
  const reported = new Set<string>();
  // The socket can hand over overlapping connections. Accepting one at a time lets the check
  // before a save see every earlier save.
  let accepting: Promise<unknown> = Promise.resolve();

  return {
    accept: (request) => {
      const reply = accepting.then(() => accept(options, request));

      accepting = reply.catch(() => undefined);

      return reply;
    },
    deliver: async (signal) => {
      options.receipts.restore(options.entries());

      for (const messageId of await pendingMessages(options.directory)) {
        if (signal.aborted) {
          return;
        }

        // oxlint-disable-next-line no-await-in-loop -- Deliveries run one at a time.
        await deliverOne(options, messageId, reported, signal);
      }
    },
  };
};
