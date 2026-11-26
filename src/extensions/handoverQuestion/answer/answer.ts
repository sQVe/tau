import type { AgentToolResult, SessionEntry } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { errorMessage } from '../../../errors.js';
import type { HcRuntime } from '../../../hc/hc.js';
import {
  handoverAnswerCharacterLimit,
  sendInboxMessage,
  uuidSchema,
} from '../../../inbox/inbox.js';
import type { InboxSendResult } from '../../../inbox/inbox.js';
import { toolResult } from '../toolResult.js';
import { receivedQuestion } from './receivedQuestion.js';

export interface AnswerTarget {
  hc: HcRuntime;
  entries: readonly SessionEntry[];
  leadSession: string;
}

export type AnswerOutcome =
  | { status: 'queued'; questionId: string }
  | { status: 'unknown'; questionId: string; note: string }
  | { status: 'refused'; questionId: string; reason: string };

export const answerParameters = Type.Object({
  questionId: uuidSchema,
  answer: Type.String({
    minLength: 1,
    maxLength: handoverAnswerCharacterLimit,
    description: 'The answer to the handover question.',
  }),
});

export type AnswerInput = Static<typeof answerParameters>;

export const answerToolDescription = [
  'Answer a handover question shown in this session, by its questionId.',
  'When the question asks for an approval-only action, ask the user with ask_user_question first.',
  'For a design question, call architect ask first.',
].join(' ');

const notSent = 'Nothing was queued.';

const notReceivedReason = (questionId: string): string =>
  `This session never received handover question ${questionId}.`;

const conflictingReceiptsReason = (questionId: string): string =>
  `This session has conflicting receipts for handover question ${questionId}.`;

const unknownNote = (sent: InboxSendResult): string => {
  const reason = sent.reason ?? 'The asker may not have received the answer.';

  return `${reason} Delivery is uncertain. A retry with the same answer and question ID is safe.`;
};

const refused = (questionId: string, reason: string): AgentToolResult<AnswerOutcome> =>
  toolResult(reason, { status: 'refused', questionId, reason }, { isError: true });

export const answerQuestion = async (
  target: AnswerTarget,
  input: AnswerInput,
): Promise<AgentToolResult<AnswerOutcome>> => {
  target.hc.signal?.throwIfAborted();

  const received = receivedQuestion(target.entries, input.questionId, target.leadSession);

  if (received.kind === 'conflict') {
    return refused(input.questionId, conflictingReceiptsReason(input.questionId));
  }

  if (received.kind === 'not-received') {
    return refused(input.questionId, notReceivedReason(input.questionId));
  }

  try {
    const sent = await sendInboxMessage({
      hc: target.hc,
      target: received.askerTerminal,
      sessionId: received.askerSession,
      messageId: input.questionId,
      refusal: notSent,
      body: {
        family: 'handover-answer',
        payload: {
          questionId: input.questionId,
          senderSession: target.leadSession,
          answer: input.answer,
        },
      },
    });

    if (sent.status === 'queued') {
      return toolResult('Answer queued for the asker. Queued is not a read receipt.', {
        status: 'queued',
        questionId: input.questionId,
      });
    }

    const note = unknownNote(sent);

    return toolResult(note, { status: 'unknown', questionId: input.questionId, note });
  } catch (error) {
    target.hc.signal?.throwIfAborted();

    return refused(input.questionId, errorMessage(error));
  }
};
