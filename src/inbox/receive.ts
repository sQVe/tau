import type { Family, MessageBody, MessageReply, MessageRequest } from './protocol.js';
import { refusedReply } from './protocol.js';
import {
  decideCandidate,
  inboxMessageType,
  inboxReceiptVersion,
  matchesReceipt,
  messageText,
  piQueueEmptyAtSettle,
} from './receiptDecision.js';
import type { InboxReceipt, ReceiptEntryFact, SettleFacts } from './receiptDecision.js';
import type { ReceiptStore } from './receipts.js';
import { deleteMessage, pendingMessages, readMessage, saveMessage } from './store.js';

interface InboxMessage {
  customType: string;
  content: string;
  display: boolean;
  details: unknown;
}

// An arrived message starts a turn. A recovered message is one Pi dropped after the user
// interrupted, so it is shown without starting one.
type Arrival = 'arrived' | 'recovered';

export type AcceptCheck = (
  request: MessageRequest,
  save: () => Promise<MessageReply>,
) => Promise<MessageReply | string>;

export interface ReceiverOptions {
  directory: string;
  terminal: string;
  sessionId: string;
  accepts: Partial<Record<Family, AcceptCheck>>;
  receipts: ReceiptStore;
  entries: () => readonly ReceiptEntryFact[];
  // Returns false when the caller holds the message. A held message is delivered by a later drain.
  wake: (message: InboxMessage, arrival: Arrival) => boolean;
  notify: (message: string) => void;
}

export interface Receiver {
  accept: (request: MessageRequest) => Promise<MessageReply>;
  deliver: (signal: AbortSignal) => Promise<void>;
  // Makes deliverable again each queued message that Pi dropped before saving its receipt.
  releaseDropped: (facts: SettleFacts) => void;
}

const queuedReply = (options: ReceiverOptions, messageId: string): MessageReply => ({
  protocol: 'rpc1',
  kind: 'queued',
  messageId,
  terminal: options.terminal,
  sessionId: options.sessionId,
});

const bodyOf = (request: MessageRequest): MessageBody =>
  request.family === 'handover'
    ? { family: 'handover', payload: request.payload }
    : { family: 'answer', payload: request.payload };

const changedReply = (messageId: string): MessageReply =>
  refusedReply(`Message ${messageId} is already saved with different content.`, messageId);

const save = async (options: ReceiverOptions, request: MessageRequest): Promise<MessageReply> => {
  const { messageId } = request;
  const body = bodyOf(request);

  options.receipts.restore(options.entries());

  const receipted = options.receipts.receiptedMessage(messageId);

  if (receipted !== undefined) {
    return matchesReceipt(receipted, body)
      ? queuedReply(options, messageId)
      : changedReply(messageId);
  }

  const outcome = await saveMessage(options.directory, { version: 1, messageId, ...body });

  return outcome === 'changed' ? changedReply(messageId) : queuedReply(options, messageId);
};

const accept = async (options: ReceiverOptions, request: MessageRequest): Promise<MessageReply> => {
  const { messageId, family } = request;
  const check = options.accepts[family];

  if (check === undefined) {
    return refusedReply(`This session does not accept ${family} messages.`, messageId);
  }

  const reply = await check(request, () => save(options, request));

  return typeof reply === 'string' ? refusedReply(reply, messageId) : reply;
};

const receiptOf = (
  options: ReceiverOptions,
  messageId: string,
  body: MessageBody,
): InboxReceipt => {
  const identity = {
    version: inboxReceiptVersion,
    messageId,
    sessionId: options.sessionId,
  } as const;

  return body.family === 'answer'
    ? { ...identity, family: body.family, questionId: body.payload.questionId }
    : { ...identity, family: body.family };
};

const wakeOnce = (options: ReceiverOptions, messageId: string, body: MessageBody): void => {
  const arrival = options.receipts.isRecovered(messageId) ? 'recovered' : 'arrived';

  options.receipts.markQueued(messageId);

  try {
    const message = {
      customType: inboxMessageType,
      content: messageText(body),
      display: true,
      details: receiptOf(options, messageId, body),
    };

    const shown = options.wake(message, arrival);

    if (!shown) {
      options.receipts.clearQueued(messageId);
    }
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

export const createReceiver = (options: ReceiverOptions): Receiver => {
  const reported = new Set<string>();
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
    releaseDropped: (facts) => {
      if (!piQueueEmptyAtSettle(facts)) {
        return;
      }

      options.receipts.restore(options.entries());
      options.receipts.releaseQueued();
    },
  };
};
