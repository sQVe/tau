import { readInboxReceipt } from './receiptDecision.js';
import type { ReceiptedMessage, ReceiptEntryFact } from './receiptDecision.js';

export interface ReceiptStore {
  restore: (entries: readonly ReceiptEntryFact[]) => void;
  hasReceipt: (messageId: string) => boolean;
  receiptedMessage: (messageId: string) => ReceiptedMessage | undefined;
  markQueued: (messageId: string) => void;
  clearQueued: (messageId: string) => void;
  isQueued: (messageId: string) => boolean;
  // Makes each queued message without a receipt deliverable again.
  releaseQueued: () => void;
  // A released message stays recovered until its receipt is saved.
  isRecovered: (messageId: string) => boolean;
}

export const createReceiptStore = (sessionId: string): ReceiptStore => {
  const receiptedMessages = new Map<string, ReceiptedMessage>();
  const queuedMessageIds = new Set<string>();
  const recoveredMessageIds = new Set<string>();

  const restore = (entries: readonly ReceiptEntryFact[]): void => {
    receiptedMessages.clear();

    for (const entry of entries) {
      const receipt = readInboxReceipt(entry);

      if (receipt === undefined || receipt.sessionId !== sessionId) {
        continue;
      }

      receiptedMessages.set(receipt.messageId, { receipt, content: entry.content });
      queuedMessageIds.delete(receipt.messageId);
      recoveredMessageIds.delete(receipt.messageId);
    }
  };

  const releaseQueued = (): void => {
    for (const messageId of queuedMessageIds) {
      recoveredMessageIds.add(messageId);
    }

    queuedMessageIds.clear();
  };

  return {
    restore,
    hasReceipt: (messageId) => receiptedMessages.has(messageId),
    receiptedMessage: (messageId) => receiptedMessages.get(messageId),
    markQueued: (messageId) => queuedMessageIds.add(messageId),
    clearQueued: (messageId) => queuedMessageIds.delete(messageId),
    isQueued: (messageId) => queuedMessageIds.has(messageId),
    releaseQueued,
    isRecovered: (messageId) => recoveredMessageIds.has(messageId),
  };
};
