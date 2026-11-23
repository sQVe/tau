import { errorMessage } from '../../../errors.js';
import type { AcceptCheck } from '../../../inbox/inbox.js';
import { findTauRoot } from '../../../tauDirectory.js';
import type { QuestionRecord } from '../question/questionRecord.js';
import { readQuestionRecord, writeQuestionRecord } from '../question/questionRecord.js';
import { decideAnswer } from './answerDecision.js';

type Save = Parameters<AcceptCheck>[1];

type RootRead = { kind: 'root'; root: string } | { kind: 'refused'; reason: string };

const rootOf = async (cwd: string): Promise<RootRead> => {
  try {
    return { kind: 'root', root: await findTauRoot(cwd, 'handover_answer') };
  } catch (error) {
    return { kind: 'refused', reason: errorMessage(error) };
  }
};

const savedOrRestored = async (
  root: string,
  open: QuestionRecord,
  save: Save,
): ReturnType<Save> => {
  let reply: Awaited<ReturnType<Save>>;

  try {
    reply = await save();
  } catch (error) {
    await writeQuestionRecord(root, open);

    throw error;
  }

  if (reply.kind !== 'queued') {
    await writeQuestionRecord(root, open);
  }

  return reply;
};

export const handoverAnswerCheck =
  (cwd: () => string | undefined): AcceptCheck =>
  async (request, save) => {
    if (request.family !== 'handover-answer') {
      return `This check accepts handover answers, not ${request.family} messages.`;
    }

    const directory = cwd();

    if (directory === undefined) {
      return 'This session has not started, so it cannot accept a handover answer.';
    }

    const found = await rootOf(directory);

    if (found.kind === 'refused') {
      return found.reason;
    }

    const read = await readQuestionRecord(found.root, request.payload.questionId);

    const decision = decideAnswer({
      messageId: request.messageId,
      targetSessionId: request.targetSessionId,
      payload: request.payload,
      read,
    });

    if (decision.kind === 'refuse') {
      return decision.reason;
    }

    if (decision.kind === 'save') {
      return save();
    }

    await writeQuestionRecord(found.root, decision.answered);

    return savedOrRestored(found.root, decision.open, save);
  };
