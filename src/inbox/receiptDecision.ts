import { isRecord } from '../schema.js';
import { families } from './protocol.js';
import type { Family } from './protocol.js';

export interface InboxReceipt {
  version: 2;
  messageId: string;
  sessionId: string;
  family: Family;
}

export interface ReceiptEntryFact {
  type: string;
  customType?: string | undefined;
  details?: unknown;
}

export interface CandidateFacts {
  hasOwnReceipt: boolean;
  queued: boolean;
}

export type CandidateStep = 'cleanup' | 'pending' | 'read';

export const inboxMessageType = 'tau-inbox-message';
export const inboxReceiptVersion = 2;

const isFamily = (value: unknown): value is Family => families.some((family) => family === value);

// A newer or malformed receipt is skipped, so it never hides the valid ones beside it.
export const readInboxReceipt = (entry: ReceiptEntryFact): InboxReceipt | undefined => {
  const isReceiptEntry = entry.type === 'custom_message' && entry.customType === inboxMessageType;

  if (!isReceiptEntry || !isRecord(entry.details)) {
    return undefined;
  }

  const { version, messageId, sessionId, family } = entry.details;
  const hasMessageId = typeof messageId === 'string' && messageId !== '';
  const hasSessionId = typeof sessionId === 'string' && sessionId !== '';
  const hasIdentity = hasMessageId && hasSessionId;

  if (!hasIdentity || version !== inboxReceiptVersion || !isFamily(family)) {
    return undefined;
  }

  return { version: inboxReceiptVersion, messageId, sessionId, family };
};

export const decideCandidate = ({ hasOwnReceipt, queued }: CandidateFacts): CandidateStep => {
  if (hasOwnReceipt) {
    return 'cleanup';
  }

  if (queued) {
    return 'pending';
  }

  return 'read';
};
