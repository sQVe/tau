import { createHash } from 'node:crypto';

import { exampleCount, pastExamples } from '../../src/questionGate/examples.ts';
import type {
  JudgeQuestion,
  PastAnswer,
  PastOutcome,
} from '../../src/questionGate/questionGate.ts';
import type { LoggedQuestion } from './questionGateScoreLog.ts';

export interface ScoreSelection {
  since: number | undefined;
  until: number | undefined;
  limit: number;
  holdout: number;
}

export interface PreparedQuestion {
  session: string;
  split: 'tuning' | 'holdout';
  question: JudgeQuestion;
  outcome: PastOutcome;
  examples: PastAnswer[];
}

const hashHexDigits = 8;
const hashBits = 32;
const hashSpace = 2 ** hashBits;

const inWindow = (time: number, selection: ScoreSelection): boolean => {
  const afterStart = selection.since === undefined || time >= selection.since;
  const beforeEnd = selection.until === undefined || time < selection.until;

  return afterStart && beforeEnd;
};

const lastAnswered = (questions: readonly LoggedQuestion[]): number =>
  questions.at(-1)?.answeredAt ?? 0;

// A live gate would have every question in a session it reads, so the limit takes whole sessions.
const selectQuestions = (questions: readonly LoggedQuestion[], limit: number): LoggedQuestion[] => {
  const groups = new Map<string, LoggedQuestion[]>();

  for (const question of questions) {
    const group = groups.get(question.session) ?? [];

    group.push(question);
    groups.set(question.session, group);
  }

  const newestFirst = [...groups.values()].toSorted(
    (left, right) => lastAnswered(right) - lastAnswered(left),
  );

  const selected: LoggedQuestion[] = [];

  for (const group of newestFirst) {
    if (selected.length >= limit) {
      break;
    }

    selected.push(...group);
  }

  return selected;
};

const isHeldOut = (session: string, holdout: number): boolean => {
  const digest = createHash('sha256').update(session).digest('hex').slice(0, hashHexDigits);
  const fraction = Number.parseInt(digest, 16) / hashSpace;

  return fraction < holdout;
};

const pastAnswer = (question: LoggedQuestion): PastAnswer => ({
  time: question.askedAt,
  question: question.question,
  outcome: question.outcome,
});

export const prepareScoreQuestions = (
  questions: readonly LoggedQuestion[],
  selection: ScoreSelection,
): PreparedQuestion[] => {
  const inWindowQuestions = questions.filter((question) =>
    inWindow(question.answeredAt, selection),
  );

  const selected = selectQuestions(inWindowQuestions, selection.limit);
  const answers = questions.map(pastAnswer);

  return selected.map((question) => ({
    session: question.session,
    split: isHeldOut(question.session, selection.holdout) ? 'holdout' : 'tuning',
    question: question.question,
    outcome: question.outcome,
    examples: pastExamples(answers, question.askedAt, exampleCount),
  }));
};
