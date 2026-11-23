import { isSenderTerminal, parseSenderLine, senderLine } from '../handoverSender.js';
import { isRecord } from '../schema.js';
import { isSessionId, isUuid } from './protocol.js';
import type { SavableMessageBody } from './protocol.js';

interface ReceiptIdentity {
  version: InboxReceiptVersion;
  messageId: string;
  sessionId: string;
}

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

interface HandoverQuestionHeading {
  questionId: string;
  askerTerminal: string;
  askerSession: string;
}

export const inboxReceiptVersion = 4;

const previousInboxReceiptVersion = 2;

const handoverQuestionReceiptVersion = 3;

type InboxReceiptVersion =
  | typeof previousInboxReceiptVersion
  | typeof handoverQuestionReceiptVersion
  | typeof inboxReceiptVersion;

type QuestionReceiptVersion = typeof handoverQuestionReceiptVersion | typeof inboxReceiptVersion;

export type InboxReceipt =
  | (ReceiptIdentity & { family: 'handover' })
  | (ReceiptIdentity & { family: 'answer'; questionId?: string })
  | (ReceiptIdentity & {
      version: QuestionReceiptVersion;
      family: 'handover-question';
      questionId: string;
    })
  | (ReceiptIdentity & {
      version: typeof inboxReceiptVersion;
      family: 'handover-answer';
      questionId: string;
    });

export const inboxMessageType = 'tau-inbox-message';

const isReceiptVersion = (value: unknown): value is InboxReceiptVersion =>
  value === previousInboxReceiptVersion ||
  value === handoverQuestionReceiptVersion ||
  value === inboxReceiptVersion;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

const isQuestionId = (value: unknown): value is string =>
  typeof value === 'string' && isUuid(value);

const handoverQuestionReceipt = (
  identity: ReceiptIdentity,
  questionId: unknown,
): InboxReceipt | undefined => {
  if (identity.version === previousInboxReceiptVersion) {
    return undefined;
  }

  if (!isQuestionId(questionId)) {
    return undefined;
  }

  const { version, messageId, sessionId } = identity;

  return { version, messageId, sessionId, family: 'handover-question', questionId };
};

const handoverAnswerReceipt = (
  identity: ReceiptIdentity,
  questionId: unknown,
): InboxReceipt | undefined => {
  if (identity.version !== inboxReceiptVersion) {
    return undefined;
  }

  if (!isQuestionId(questionId)) {
    return undefined;
  }

  const { version, messageId, sessionId } = identity;

  return { version, messageId, sessionId, family: 'handover-answer', questionId };
};

const questionDetails = (questionId: unknown): { questionId?: string } =>
  typeof questionId === 'string' ? { questionId } : {};

const readInboxMessage = (message: InboxMessageFact): InboxReceipt | undefined => {
  if (message.customType !== inboxMessageType || !isRecord(message.details)) {
    return undefined;
  }

  const { version, messageId, sessionId, family, questionId } = message.details;
  const hasMessageId = isNonEmptyString(messageId);
  const hasSessionId = isNonEmptyString(sessionId);

  if (!hasMessageId || !hasSessionId || !isReceiptVersion(version)) {
    return undefined;
  }

  switch (family) {
    case 'handover':
      return { version, messageId, sessionId, family };

    case 'answer':
      return { version, messageId, sessionId, family, ...questionDetails(questionId) };

    case 'handover-question':
      return handoverQuestionReceipt({ version, messageId, sessionId }, questionId);

    case 'handover-answer':
      return handoverAnswerReceipt({ version, messageId, sessionId }, questionId);

    default:
      return undefined;
  }
};

export const readInboxReceipt = (entry: ReceiptEntryFact): InboxReceipt | undefined =>
  entry.type === 'custom_message' ? readInboxMessage(entry) : undefined;

export const answeredQuestionId = (message: InboxMessageFact): string | undefined => {
  const receipt = readInboxMessage(message);

  return receipt?.family === 'answer' ? receipt.questionId : undefined;
};

const handoverQuestionHeadingExpression =
  /^Handover question (\S+) from terminal (\S+), session (\S+):$/u;

const handoverQuestionHeading = (payload: HandoverQuestionHeading): string =>
  `Handover question ${payload.questionId} from terminal ${payload.askerTerminal}, session ${payload.askerSession}:`;

export const parseHandoverQuestionHeading = (
  content: unknown,
): HandoverQuestionHeading | undefined => {
  if (typeof content !== 'string') {
    return undefined;
  }

  const firstLine = content.split(/\r?\n/u)[0] ?? '';
  const match = handoverQuestionHeadingExpression.exec(firstLine);

  if (match === null) {
    return undefined;
  }

  const questionId = match[1] ?? '';
  const askerTerminal = match[2] ?? '';
  const askerSession = match[3] ?? '';

  if (!isUuid(questionId) || !isSenderTerminal(askerTerminal) || !isSessionId(askerSession)) {
    return undefined;
  }

  return { questionId, askerTerminal, askerSession };
};

export const messageText = (body: SavableMessageBody): string => {
  if (body.family === 'answer') {
    return body.payload.answer;
  }

  if (body.family === 'handover-question') {
    return `${handoverQuestionHeading(body.payload)}\n\n${body.payload.text}`;
  }

  if (body.family === 'handover-answer') {
    const { questionId, answer } = body.payload;

    return `Handover answer to question ${questionId}:\n\n${answer}`;
  }

  const { text, sender } = body.payload;

  if (sender !== undefined) {
    return `${senderLine(sender)}\n\n${text}`;
  }

  return parseSenderLine(text) === undefined ? text : `Handover text without a sender:\n\n${text}`;
};

const matchesSenderFreePayload = (content: unknown, body: SavableMessageBody): boolean => {
  if (body.family !== 'handover' || body.payload.sender !== undefined) {
    return false;
  }

  return content === body.payload.text;
};

export const matchesReceipt = (
  { receipt, content }: ReceiptedMessage,
  body: SavableMessageBody,
): boolean => {
  const keepsQuestion =
    receipt.family === 'answer' ||
    receipt.family === 'handover-question' ||
    receipt.family === 'handover-answer';

  const receiptQuestionId = keepsQuestion ? receipt.questionId : undefined;

  const bodyKeepsQuestion =
    body.family === 'answer' ||
    body.family === 'handover-question' ||
    body.family === 'handover-answer';

  const bodyQuestionId = bodyKeepsQuestion ? body.payload.questionId : undefined;
  const sameQuestion = receiptQuestionId === bodyQuestionId;
  const sameContent = content === messageText(body) || matchesSenderFreePayload(content, body);

  return receipt.family === body.family && sameContent && sameQuestion;
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
