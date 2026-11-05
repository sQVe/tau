import { readInboxReceipt } from './receiptDecision.js';
import type { ReceiptEntryFact } from './receiptDecision.js';

export interface ReceiptStore {
  restore: (entries: readonly ReceiptEntryFact[]) => void;
  hasReceipt: (messageId: string) => boolean;
  markQueued: (messageId: string) => void;
  isQueued: (messageId: string) => boolean;
}

export const createReceiptStore = (sessionId: string): ReceiptStore => {
  const savedMessageIds = new Set<string>();
  const queuedMessageIds = new Set<string>();

  const restore = (entries: readonly ReceiptEntryFact[]): void => {
    savedMessageIds.clear();

    for (const entry of entries) {
      const receipt = readInboxReceipt(entry);

      if (receipt === undefined || receipt.sessionId !== sessionId) {
        continue;
      }

      savedMessageIds.add(receipt.messageId);
      queuedMessageIds.delete(receipt.messageId);
    }
  };

  return {
    restore,
    hasReceipt: (messageId) => savedMessageIds.has(messageId),
    markQueued: (messageId) => queuedMessageIds.add(messageId),
    isQueued: (messageId) => queuedMessageIds.has(messageId),
  };
};
