import { errorMessage } from '../../errors.js';
import type { HcRuntime } from '../../hc/hc.js';
import type { AcceptCheck } from '../../inbox/inbox.js';
import { sendAnswer, unknownNote } from './answer.js';

export interface AnswerRequestFacts {
  hc: HcRuntime;
  parentSession: string | undefined;
  terminal: string | undefined;
  sessionId: string;
}

export const answerRequestCheck =
  (facts: () => AnswerRequestFacts | undefined): AcceptCheck =>
  async (request) => {
    if (request.family !== 'answer-request') {
      return `This check accepts answer requests, not ${request.family} messages.`;
    }

    const current = facts();

    if (current === undefined) {
      return 'This session has not started, so it cannot answer a worker.';
    }

    if (current.parentSession === undefined || current.parentSession === '') {
      return 'This session has no saved Pi session file, so it cannot answer a worker.';
    }

    if (current.terminal === undefined) {
      return 'This session has no HC_TERMINAL_ID, so it cannot answer a worker.';
    }

    try {
      const sent = await sendAnswer(current.hc, {
        parameters: request.payload,
        parentSession: current.parentSession,
      });

      if (sent.status === 'unknown') {
        return {
          protocol: 'rpc1',
          kind: 'unknown',
          messageId: request.messageId,
          reason: unknownNote(sent),
        };
      }

      return {
        protocol: 'rpc1',
        kind: 'queued',
        messageId: request.messageId,
        terminal: current.terminal,
        sessionId: current.sessionId,
      };
    } catch (error) {
      return errorMessage(error);
    }
  };
