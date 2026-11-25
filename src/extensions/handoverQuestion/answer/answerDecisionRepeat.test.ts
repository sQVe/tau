import { assert, constantFrom, property, record, string, tuple } from 'fast-check';
import { expect, it } from 'vitest';

import { resolvePropertySeed } from '../../../../tests/propertySeedHarness.js';
import type { QuestionRecord } from '../question/questionRecord.js';
import { decideAnswer } from './answerDecision.js';

const identifier = string({ minLength: 1 });
const answer = string({ minLength: 1 });

const recordFields = record({
  questionId: identifier,
  askerTerminal: identifier,
  askerSession: identifier,
  senderTerminal: identifier,
  senderSession: identifier,
  text: identifier,
  askedAt: identifier,
});

const differentAnswers = tuple(answer, answer).filter(
  ([savedAnswer, givenAnswer]) => savedAnswer !== givenAnswer,
);

it('never refuses a repeat of the same answer and leaves the record answered', () => {
  const seed = resolvePropertySeed();

  assert(
    property(
      recordFields,
      answer,
      constantFrom('open', 'answered'),
      (fields, savedAnswer, state) => {
        const firstRecord: QuestionRecord =
          state === 'open'
            ? { version: 1, ...fields, state: 'open', answer: null }
            : { version: 1, ...fields, state: 'answered', answer: savedAnswer };

        const facts = {
          messageId: fields.questionId,
          targetSessionId: fields.askerSession,
          payload: {
            questionId: fields.questionId,
            senderSession: fields.senderSession,
            answer: savedAnswer,
          },
          read: { kind: 'record' as const, record: firstRecord },
        };

        const first = decideAnswer(facts);
        const answered = first.kind === 'markAnswered' ? first.answered : firstRecord;
        const second = decideAnswer({ ...facts, read: { kind: 'record', record: answered } });

        expect(first.kind).not.toBe('refuse');
        expect(answered.state).toBe('answered');
        expect(second).toEqual({ kind: 'save' });
      },
    ),
    { seed, numRuns: 100 },
  );
});

it('always refuses a different answer on an answered record', () => {
  const seed = resolvePropertySeed();

  assert(
    property(recordFields, differentAnswers, (fields, [savedAnswer, givenAnswer]) => {
      const answeredRecord: QuestionRecord = {
        version: 1,
        ...fields,
        state: 'answered',
        answer: savedAnswer,
      };

      const decision = decideAnswer({
        messageId: fields.questionId,
        targetSessionId: fields.askerSession,
        payload: {
          questionId: fields.questionId,
          senderSession: fields.senderSession,
          answer: givenAnswer,
        },
        read: { kind: 'record', record: answeredRecord },
      });

      expect(decision.kind).toBe('refuse');

      const reason = decision.kind === 'refuse' ? decision.reason : '';

      expect(reason).toContain(fields.questionId);
    }),
    { seed, numRuns: 100 },
  );
});
