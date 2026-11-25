import type { SessionEntry } from '@earendil-works/pi-coding-agent';

import { askQuestions, askResultOf } from '../../sessionMessage/askResult.ts';
import type { AskAnswer, AskQuestion } from '../../sessionMessage/askResult.ts';
import { assistantCalls, entryMessage } from '../../sessionMessage/sessionMessage.ts';
import type { CalledTool } from '../../sessionMessage/sessionMessage.ts';

interface AskCall {
  id: string;
  questions: AskQuestion[];
}

interface SelectedAnswer {
  question: string;
  selected: string[];
}

type Unique<T> = { kind: 'found'; value: T } | { kind: 'missing' } | { kind: 'ambiguous' };

const duplicateCall = 'duplicate';

type CallMatch = AskCall | typeof duplicateCall;

const branchStart = (branch: readonly SessionEntry[]): number => {
  const index = branch.findLastIndex((entry) => entryMessage(entry)?.role === 'user');

  return index + 1;
};

const askCallOf = (call: CalledTool) => ({
  id: call.callId,
  questions: askQuestions(call.arguments),
});

const askCallsOf = (message: Record<string, unknown>): AskCall[] => {
  if (message.role !== 'assistant') {
    return [];
  }

  const asked = assistantCalls(message).calls.filter((call) => call.tool === 'ask_user_question');

  return asked.map(askCallOf);
};

const selectedAnswerOf = (answer: AskAnswer): SelectedAnswer | undefined => {
  if (answer.typed !== false || answer.question === undefined || answer.selected === undefined) {
    return undefined;
  }

  return { question: answer.question, selected: answer.selected };
};

const uniqueOf = <T>(values: readonly T[], matches: (value: T) => boolean): Unique<T> => {
  const found = values.filter(matches);
  const first = found[0];

  if (first === undefined) {
    return { kind: 'missing' };
  }

  if (found.length > 1) {
    return { kind: 'ambiguous' };
  }

  return { kind: 'found', value: first };
};

const linesOf = (preview: string | undefined): string[] => {
  if (preview === undefined) {
    return [];
  }

  return preview.split('\n').map((line) => line.trim());
};

const answerLines = (answer: SelectedAnswer, questions: readonly AskQuestion[]): string[] => {
  const questionMatch = uniqueOf(questions, (candidate) => candidate.question === answer.question);

  if (questionMatch.kind !== 'found') {
    return [];
  }

  const question = questionMatch.value;

  if (question.kind !== 'approval') {
    return [];
  }

  const options = question.options;

  if (options === undefined) {
    return [];
  }

  const lines: string[] = [];

  for (const label of answer.selected) {
    const optionMatch = uniqueOf(options, (option) => option.label === label);

    if (optionMatch.kind === 'ambiguous') {
      return [];
    }

    if (optionMatch.kind === 'found') {
      lines.push(...linesOf(optionMatch.value.preview));
    }
  }

  return lines;
};

const resultLines = (
  message: Record<string, unknown>,
  calls: ReadonlyMap<string, CallMatch>,
): string[] => {
  const result = askResultOf(message);

  if (result?.kind !== 'answered' || result.callId === undefined) {
    return [];
  }

  const call = calls.get(result.callId);

  if (call === undefined || call === duplicateCall) {
    return [];
  }

  return result.answers.flatMap((value) => {
    const answer = selectedAnswerOf(value);

    return answer === undefined ? [] : answerLines(answer, call.questions);
  });
};

export const approvedPreviewLines = (branch: readonly SessionEntry[]): string[] => {
  const start = branchStart(branch);
  const calls = new Map<string, CallMatch>();
  const lines: string[] = [];

  for (const entry of branch.slice(start)) {
    const message = entryMessage(entry);

    if (message === undefined) {
      continue;
    }

    for (const call of askCallsOf(message)) {
      if (calls.has(call.id)) {
        calls.set(call.id, duplicateCall);

        continue;
      }

      calls.set(call.id, call);
    }

    if (message.role === 'toolResult') {
      lines.push(...resultLines(message, calls));
    }
  }

  return lines;
};

export const approvesCancel = (lines: readonly string[], identifier: string): boolean => {
  const line = `Cancel ${identifier}`;

  return lines.some((item) => item === line || item.startsWith(`${line}: `));
};
