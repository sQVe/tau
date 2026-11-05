import { isRecord } from '../schema.js';

export interface InboxReceipt {
  version: 1;
  messageId: string;
  sessionId: string;
  family: 'handover';
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

export type EnvelopeSessionStep = 'deliver' | 'defer';

export const inboxMessageType = 'tau-inbox-message';
export const inboxReceiptVersion = 1;

export const readInboxReceipt = (entry: ReceiptEntryFact): InboxReceipt | undefined => {
  const isReceiptEntry = entry.type === 'custom_message' && entry.customType === inboxMessageType;

  if (!isReceiptEntry || !isRecord(entry.details)) {
    return undefined;
  }

  const { version, messageId, sessionId, family } = entry.details;
  const hasMessageId = typeof messageId === 'string' && messageId !== '';
  const hasSessionId = typeof sessionId === 'string' && sessionId !== '';
  const isSupported = version === inboxReceiptVersion && family === 'handover';

  if (!hasMessageId || !hasSessionId || !isSupported) {
    return undefined;
  }

  return { version: inboxReceiptVersion, messageId, sessionId, family: 'handover' };
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

export const decideEnvelopeSession = (
  targetSessionId: string,
  ownSessionId: string,
): EnvelopeSessionStep => (targetSessionId === ownSessionId ? 'deliver' : 'defer');
