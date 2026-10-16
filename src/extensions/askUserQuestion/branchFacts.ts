import type { SessionEntry } from '@earendil-works/pi-coding-agent';

import type { BranchFact } from './typedAnswerGuard.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// Details without a boolean `typed` count as not typed, so an unreadable result blocks no call.
const hasTypedAnswer = (details: unknown): boolean => {
  if (!isRecord(details) || details.kind !== 'answered' || !Array.isArray(details.answers)) {
    return false;
  }

  return details.answers.some((answer) => isRecord(answer) && answer.typed === true);
};

const isVisibleText = (block: unknown): boolean => {
  if (!isRecord(block) || block.type !== 'text') {
    return false;
  }

  return typeof block.text === 'string' && block.text.trim() !== '';
};

const hasVisibleText = (content: unknown): boolean =>
  Array.isArray(content) && content.some(isVisibleText);

const factsFor = (entry: SessionEntry): BranchFact[] => {
  if (entry.type !== 'message') {
    return [];
  }

  const message: unknown = entry.message;

  if (!isRecord(message)) {
    return [];
  }

  // A failed call, such as a refusal by this guard, answers nothing.
  const answersQuestions = message.toolName === 'ask_user_question' && message.isError !== true;

  if (message.role === 'toolResult' && answersQuestions) {
    return [{ kind: 'askResult', typed: hasTypedAnswer(message.details) }];
  }

  if (message.role === 'assistant' && hasVisibleText(message.content)) {
    return [{ kind: 'visibleText' }];
  }

  return [];
};

export const branchFacts = (branch: readonly SessionEntry[]): BranchFact[] =>
  branch.flatMap(factsFor);
