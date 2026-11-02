import { randomUUID } from 'node:crypto';

import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { send } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { saveQuestion } from './assignment.js';
import type { Assignment, SavedQuestion } from './assignment.js';
import { stepFailure } from './report.js';

export interface QuestionTarget {
  hc: HcRuntime;
  parent: string;
  assignmentPath: string;
  assignment: Assignment;
}

export const questionParameters = Type.Object({
  question: Type.String({
    minLength: 1,
    maxLength: 4000,
    description:
      'The question only the parent can answer. Ask one clear question. Your turn ends, and the parent answers in a new message.',
  }),
});

export type QuestionInput = Static<typeof questionParameters>;

const resultText = (failures: readonly string[]): string =>
  failures.length === 0
    ? 'Question saved. Parent notified. Wait for the parent reply.'
    : `Question saved. ${failures.join(' ')} Wait for the parent reply.`;

export const askParent = async (
  target: QuestionTarget,
  parameters: QuestionInput,
): Promise<AgentToolResult<SavedQuestion>> => {
  const question: SavedQuestion = {
    questionId: randomUUID(),
    text: parameters.question,
    askedAt: Date.now(),
  };

  await saveQuestion(target.assignmentPath, question);
  target.assignment.questions = [...target.assignment.questions, question];

  const failures: string[] = [];

  try {
    await send(target.hc, target.parent, { text: `[tau-question] ${target.assignmentPath}` });
  } catch (error) {
    failures.push(stepFailure('Question note', error));
  }

  return {
    content: [{ type: 'text' as const, text: resultText(failures) }],
    details: question,
    terminate: true,
  };
};
