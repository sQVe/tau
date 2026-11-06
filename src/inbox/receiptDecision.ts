import { isRecord } from '../schema.js';
import { families } from './protocol.js';
import type { Family } from './protocol.js';

interface ReceiptIdentity {
  version: 2;
  messageId: string;
  sessionId: string;
}

// An answer's receipt names its question, so a resumed worker knows which wait it ended.
export type InboxReceipt = ReceiptIdentity &
  ({ family: 'handover' } | { family: 'answer'; questionId?: string });

// A message Pi started has no entry type, so the message and the saved entry share this reader.
interface InboxMessageFact {
  customType?: string | undefined;
  details?: unknown;
}

export interface ReceiptEntryFact extends InboxMessageFact {
  type: string;
}

export interface CandidateFacts {
  hasOwnReceipt: boolean;
  queued: boolean;
}

export type CandidateStep = 'cleanup' | 'pending' | 'read';

export const inboxMessageType = 'tau-inbox-message';
export const inboxReceiptVersion = 2;

const isFamily = (value: unknown): value is Family => families.some((family) => family === value);

const questionDetails = (questionId: unknown): { questionId?: string } =>
  typeof questionId === 'string' ? { questionId } : {};

// A newer or malformed receipt is skipped, so it never hides the valid ones beside it.
const readInboxMessage = (message: InboxMessageFact): InboxReceipt | undefined => {
  if (message.customType !== inboxMessageType || !isRecord(message.details)) {
    return undefined;
  }

  const { version, messageId, sessionId, family, questionId } = message.details;
  const hasMessageId = typeof messageId === 'string' && messageId !== '';
  const hasSessionId = typeof sessionId === 'string' && sessionId !== '';
  const hasIdentity = hasMessageId && hasSessionId;

  if (!hasIdentity || version !== inboxReceiptVersion || !isFamily(family)) {
    return undefined;
  }

  const identity = { version: inboxReceiptVersion, messageId, sessionId } as const;

  return family === 'answer'
    ? { ...identity, family, ...questionDetails(questionId) }
    : { ...identity, family };
};

export const readInboxReceipt = (entry: ReceiptEntryFact): InboxReceipt | undefined =>
  entry.type === 'custom_message' ? readInboxMessage(entry) : undefined;

export const answeredQuestionId = (message: InboxMessageFact): string | undefined => {
  const receipt = readInboxMessage(message);

  return receipt?.family === 'answer' ? receipt.questionId : undefined;
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
