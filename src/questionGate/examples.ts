import type { PastAnswer } from './questionGate.ts';

export const exampleCount = 5;

export const pastExamples = (
  answers: readonly PastAnswer[],
  before: number,
  count: number,
): PastAnswer[] => {
  if (count <= 0) {
    return [];
  }

  const older = answers.filter((answer) => answer.time < before);
  const oldestFirst = older.toSorted((left, right) => left.time - right.time);

  return oldestFirst.slice(Math.max(0, oldestFirst.length - count));
};
