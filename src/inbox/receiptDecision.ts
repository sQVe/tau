import { isRecord } from '../schema.js';
import { families } from './protocol.js';
import type { Family, MessageBody } from './protocol.js';

interface ReceiptIdentity {
  version: 2;
  messageId: string;
  sessionId: string;
}

export type InboxReceipt = ReceiptIdentity &
  ({ family: 'handover' } | { family: 'answer'; questionId?: string });

interface InboxMessageFact {
  customType?: string | undefined;
  details?: unknown;
}

export interface ReceiptEntryFact extends InboxMessageFact {
  type: string;
  content?: unknown;
}

export interface CandidateFacts {
  hasOwnReceipt: boolean;
  queued: boolean;
}

export type CandidateStep = 'cleanup' | 'pending' | 'read';

export interface ReceiptedMessage {
  receipt: InboxReceipt;
  content: unknown;
}

// Facts Pi reports when a run settles. Pi exposes no read of its message queue then.
export interface SettleFacts {
  aborted: boolean;
  mode: string;
}

export const inboxMessageType = 'tau-inbox-message';
export const inboxReceiptVersion = 2;

const isFamily = (value: unknown): value is Family => families.some((family) => family === value);

const questionDetails = (questionId: unknown): { questionId?: string } =>
  typeof questionId === 'string' ? { questionId } : {};

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

export const messageText = (body: MessageBody): string =>
  body.family === 'handover' ? body.payload.text : body.payload.answer;

// A retry matches when it would show the same text for the same question as the saved entry.
export const matchesReceipt = (
  { receipt, content }: ReceiptedMessage,
  body: MessageBody,
): boolean => {
  const receiptQuestionId = receipt.family === 'answer' ? receipt.questionId : undefined;
  const bodyQuestionId = body.family === 'answer' ? body.payload.questionId : undefined;
  const sameQuestion = receiptQuestionId === bodyQuestionId;

  return receipt.family === body.family && content === messageText(body) && sameQuestion;
};

// A run that settles without an abort has drained Pi's queue. Pi's terminal UI clears the queue
// before every abort. Other modes keep the queue across an abort.
export const piQueueEmptyAtSettle = ({ aborted, mode }: SettleFacts): boolean =>
  !aborted || mode === 'tui';

export const decideCandidate = ({ hasOwnReceipt, queued }: CandidateFacts): CandidateStep => {
  if (hasOwnReceipt) {
    return 'cleanup';
  }

  if (queued) {
    return 'pending';
  }

  return 'read';
};
