import { PublishError } from '../record.js';
import type { FamilyHandler } from './inbox.js';
import type { MessageReply, MessageRequest } from './protocol.js';
import { refusedReply } from './protocol.js';
import { decideCandidate, inboxMessageType, inboxReceiptVersion } from './receiptDecision.js';
import type { ReceiptEntryFact } from './receiptDecision.js';
import type { ReceiptStore } from './receipts.js';
import { deleteHandover, pendingHandovers, publishHandover, readHandover } from './store.js';

interface InboxMessage {
  customType: string;
  content: string;
  display: boolean;
  details: unknown;
}

export interface HandoverReceiverOptions {
  // The session's own record directory.
  directory: string;
  terminal: string;
  sessionId: string;
  receipts: ReceiptStore;
  entries: () => readonly ReceiptEntryFact[];
  wake: (message: InboxMessage) => void;
  notify: (message: string) => void;
}

const queuedReply = (options: HandoverReceiverOptions, messageId: string): MessageReply => ({
  protocol: 'rpc1',
  kind: 'queued',
  messageId,
  terminal: options.terminal,
  sessionId: options.sessionId,
});

const publishReply = async (
  options: HandoverReceiverOptions,
  request: MessageRequest & { family: 'handover' },
): Promise<MessageReply> => {
  const { messageId } = request;

  const outcome = await publishHandover(options.directory, {
    version: 1,
    messageId,
    targetTerminal: request.targetTerminal,
    targetSessionId: request.targetSessionId,
    text: request.payload.text,
  });

  if (outcome === 'changed') {
    return refusedReply(`Message ${messageId} is already saved with different text.`, messageId);
  }

  return queuedReply(options, messageId);
};

const accept = async (
  options: HandoverReceiverOptions,
  request: MessageRequest,
): Promise<MessageReply> => {
  if (request.family !== 'handover') {
    return refusedReply('This handler accepts handover messages only.', request.messageId);
  }

  options.receipts.restore(options.entries());

  // A receipted message was shown already, and its record may be gone, so a retry must not save
  // it again.
  if (options.receipts.hasReceipt(request.messageId)) {
    return queuedReply(options, request.messageId);
  }

  try {
    return await publishReply(options, request);
  } catch (error) {
    // Any other failure may follow publication; the connection then closes without a reply.
    if (error instanceof PublishError && error.failure === 'notLinked') {
      return refusedReply(
        `The receiver could not save the message: ${error.message}`,
        request.messageId,
      );
    }

    throw error;
  }
};

const wakeOnce = (options: HandoverReceiverOptions, messageId: string, text: string): void => {
  options.receipts.markQueued(messageId);

  try {
    options.wake({
      customType: inboxMessageType,
      content: text,
      display: true,
      details: {
        version: inboxReceiptVersion,
        messageId,
        sessionId: options.sessionId,
        family: 'handover',
      },
    });
  } catch (error) {
    options.receipts.clearQueued(messageId);

    throw error;
  }
};

const deliverOne = async (
  options: HandoverReceiverOptions,
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
    await deleteHandover(directory, messageId);

    return;
  }

  if (step === 'pending') {
    return;
  }

  const read = await readHandover(directory, messageId);

  // A replacement generation owns delivery once this one ended during the read.
  if (signal.aborted || read.kind === 'missing') {
    return;
  }

  if (read.kind === 'malformed') {
    if (!reported.has(messageId)) {
      reported.add(messageId);
      options.notify(`Tau inbox skipped handover ${messageId}: ${read.reason}`);
    }

    return;
  }

  wakeOnce(options, messageId, read.record.text);
};

// Accepting saves the record and replies; delivery shows each saved record once and deletes it only
// after Pi saved its receipt.
export const createHandoverReceiver = (options: HandoverReceiverOptions): FamilyHandler => {
  const reported = new Set<string>();

  return {
    accept: (request) => accept(options, request),
    deliver: async (signal) => {
      options.receipts.restore(options.entries());

      for (const messageId of await pendingHandovers(options.directory)) {
        if (signal.aborted) {
          return;
        }

        // oxlint-disable-next-line no-await-in-loop -- Deliveries run one at a time.
        await deliverOne(options, messageId, reported, signal);
      }
    },
  };
};
