import { randomUUID } from 'node:crypto';

import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { errorMessage } from '../../../errors.js';
import type { HandoverSender } from '../../../handoverSender.js';
import { get } from '../../../hc/hc.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { currentInboxPath, ownInboxReady, sendInboxMessage } from '../../../inbox/inbox.js';
import { findTauRoot } from '../../../tauDirectory.js';
import { deleteQuestionRecord, writeQuestionRecord } from './questionRecord.js';
import type { QuestionRecord } from './questionRecord.js';

export interface QuestionTarget {
  hc: HcRuntime;
  cwd: string;
  askerTerminal: string;
  askerSession: string;
  sender: HandoverSender;
}

export type QuestionOutcome =
  | { status: 'sent'; questionId: string }
  | { status: 'unknown'; questionId: string; note: string }
  | { status: 'refused'; questionId: string };

export const questionParameters = Type.Object({
  question: Type.String({
    minLength: 1,
    maxLength: 4000,
    description:
      'The question only the lead that sent this handover can answer. Ask one clear question. Your turn ends, and the answer arrives as a new message.',
  }),
});

export type QuestionInput = Static<typeof questionParameters>;

export const questionToolDescription = [
  'Ask the lead that sent this handover one question only it can answer.',
  'Use it for a decision only the sender can make, a missing input, or when this spec or test looks wrong.',
  'Your turn ends, and the answer arrives as a new message.',
  'When the lead cannot be reached, ask the user with ask_user_question instead.',
].join(' ');

const refusalNote = 'Ask the user with ask_user_question.';
const unreachablePrefix = 'The lead that sent this handover cannot be reached:';

const inboxRefusal =
  'This session has no listening inbox, so the answer cannot reach it. Ask the user with ask_user_question.';

const refusalText = (error: unknown): string => {
  const reason = errorMessage(error);
  const detail = reason.endsWith(refusalNote) ? reason : `${reason} ${refusalNote}`;

  return `${unreachablePrefix} ${detail}`;
};

const sendQuestion = (target: QuestionTarget, questionId: string, text: string) =>
  sendInboxMessage({
    hc: target.hc,
    target: target.sender.terminal,
    messageId: questionId,
    sessionId: target.sender.sessionId,
    refusal: refusalNote,
    body: {
      family: 'handover-question',
      payload: {
        questionId,
        text,
        askerTerminal: target.askerTerminal,
        askerSession: target.askerSession,
      },
    },
  });

const recordOf = (target: QuestionTarget, questionId: string, text: string): QuestionRecord => ({
  version: 1,
  questionId,
  askerTerminal: target.askerTerminal,
  askerSession: target.askerSession,
  senderTerminal: target.sender.terminal,
  senderSession: target.sender.sessionId,
  text,
  askedAt: new Date().toISOString(),
  state: 'open',
  answer: null,
});

const result = (
  text: string,
  details: QuestionOutcome,
  options: { terminate?: boolean; isError?: boolean } = {},
): AgentToolResult<QuestionOutcome> => ({
  content: [{ type: 'text' as const, text }],
  details,
  ...options,
});

const askerInboxReady = async (target: QuestionTarget): Promise<boolean> => {
  const listenerPath = currentInboxPath();

  if (listenerPath === undefined) {
    return false;
  }

  try {
    const terminal = await get(target.hc, target.askerTerminal);

    return ownInboxReady({
      listenerPath,
      labels: terminal.labels ?? {},
      sessionId: target.askerSession,
    });
  } catch {
    target.hc.signal?.throwIfAborted();

    return false;
  }
};

export const askSender = async (
  target: QuestionTarget,
  input: QuestionInput,
): Promise<AgentToolResult<QuestionOutcome>> => {
  target.hc.signal?.throwIfAborted();

  const root = await findTauRoot(target.cwd, 'handover_question');
  const questionId = randomUUID();

  if (!(await askerInboxReady(target))) {
    return result(inboxRefusal, { status: 'refused', questionId }, { isError: true });
  }

  await writeQuestionRecord(root, recordOf(target, questionId, input.question));

  try {
    const sent = await sendQuestion(target, questionId, input.question);

    if (sent.status === 'queued') {
      return result(
        'Question sent. Your turn ends; the answer arrives as a new message.',
        { status: 'sent', questionId },
        { terminate: true },
      );
    }

    const note = sent.note ?? 'The lead may not have received the question.';

    return result(note, { status: 'unknown', questionId, note }, { terminate: true });
  } catch (error) {
    await deleteQuestionRecord(root, questionId);

    target.hc.signal?.throwIfAborted();

    return result(refusalText(error), { status: 'refused', questionId }, { isError: true });
  }
};
