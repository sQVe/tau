import { isRecord } from '../schema.js';

export interface InboxReceipt {
  version: 2;
  messageId: string;
  sessionId: string;
  family: InboxFamily;
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

export const inboxFamilies = ['handover', 'answer'] as const;

export type InboxFamily = (typeof inboxFamilies)[number];

export const inboxMessageType = 'tau-inbox-message';
export const inboxReceiptVersion = 2;

const isInboxFamily = (value: unknown): value is InboxFamily =>
  inboxFamilies.some((family) => family === value);

const isSupportedReceipt = (version: unknown, family: unknown): family is InboxFamily => {
  if (version === 1) {
    return family === 'handover';
  }

  return version === inboxReceiptVersion && isInboxFamily(family);
};

export const readInboxReceipt = (entry: ReceiptEntryFact): InboxReceipt | undefined => {
  const isReceiptEntry = entry.type === 'custom_message' && entry.customType === inboxMessageType;

  if (!isReceiptEntry || !isRecord(entry.details)) {
    return undefined;
  }

  const { version, messageId, sessionId, family } = entry.details;
  const hasMessageId = typeof messageId === 'string' && messageId !== '';
  const hasSessionId = typeof sessionId === 'string' && sessionId !== '';

  if (!hasMessageId || !hasSessionId || !isSupportedReceipt(version, family)) {
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

export const decideEnvelopeSession = (
  targetSessionId: string,
  ownSessionId: string,
): EnvelopeSessionStep => (targetSessionId === ownSessionId ? 'deliver' : 'defer');
