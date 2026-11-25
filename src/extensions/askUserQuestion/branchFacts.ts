import type { SessionEntry } from '@earendil-works/pi-coding-agent';

import { isRecord } from '../../schema.js';
import { askResultOf } from '../../sessionMessage/askResult.js';
import { entryMessage } from '../../sessionMessage/sessionMessage.js';
import type { BranchFact } from './typedAnswerGuard.js';

const isVisibleText = (block: unknown): boolean => {
  if (!isRecord(block) || block.type !== 'text') {
    return false;
  }

  return typeof block.text === 'string' && block.text.trim() !== '';
};

const hasVisibleText = (content: unknown): boolean =>
  Array.isArray(content) && content.some(isVisibleText);

const askResultFact = (message: Record<string, unknown>): BranchFact[] => {
  const result = askResultOf(message);

  // A failed or decided call answers nothing.
  if (result === undefined || result.kind === 'error' || result.kind === 'decided') {
    return [];
  }

  if (result.kind === 'answered') {
    return [{ kind: 'askResult', typed: result.answers.some((answer) => answer.typed === true) }];
  }

  return [{ kind: 'askResult', typed: false }];
};

const factsFor = (entry: SessionEntry): BranchFact[] => {
  const message = entryMessage(entry);

  if (message === undefined) {
    return [];
  }

  if (message.role === 'toolResult') {
    return askResultFact(message);
  }

  if (message.role === 'assistant' && hasVisibleText(message.content)) {
    return [{ kind: 'visibleText' }];
  }

  return [];
};

export const branchFacts = (branch: readonly SessionEntry[]): BranchFact[] =>
  branch.flatMap(factsFor);
