import type { AgentToolResult, SessionEntry } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { errorMessage } from '../../../errors.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { sendInboxMessage, uuidSchema } from '../../../inbox/inbox.js';
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
    maxLength: 32_000,
    description: 'The answer to the handover question.',
  }),
});

export type AnswerInput = Static<typeof answerParameters>;

export const answerToolDescription = [
  'Answer a handover question shown in this session, by its questionId.',
  'When the question asks for an approval-only action, ask the user with ask_user_question first.',
  'Send a design question to architect ask first.',
].join(' ');

const unreachable = 'Tell the user the asker cannot be reached.';

const notReceivedReason = (questionId: string): string =>
  `This session never received handover question ${questionId}.`;

const unknownNote = (sent: InboxSendResult): string => {
  const reason = sent.reason ?? 'The asker may not have received the answer.';

  return `${reason} Delivery is uncertain. A retry with the same answer and question ID is safe.`;
};

export const answerQuestion = async (
  target: AnswerTarget,
  input: AnswerInput,
): Promise<AgentToolResult<AnswerOutcome>> => {
  target.hc.signal?.throwIfAborted();

  const received = receivedQuestion(target.entries, input.questionId, target.leadSession);

  if (received === undefined) {
    const reason = notReceivedReason(input.questionId);

    return toolResult(
      reason,
      { status: 'refused', questionId: input.questionId, reason },
      { isError: true },
    );
  }

  try {
    const sent = await sendInboxMessage({
      hc: target.hc,
      target: received.askerTerminal,
      sessionId: received.askerSession,
      messageId: input.questionId,
      refusal: unreachable,
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

    const reason = errorMessage(error);

    return toolResult(
      reason,
      { status: 'refused', questionId: input.questionId, reason },
      { isError: true },
    );
  }
};
