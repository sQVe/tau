import { isRecord, text } from '../schema.ts';
import type { AskKind } from '../schema.ts';

export interface AskAnswer {
  question: string | undefined;
  selected: string[] | undefined;
  typed: boolean | undefined;
}

export type AskResult =
  | { kind: 'error' }
  | { kind: 'decided' }
  | { kind: 'answered'; callId: string | undefined; answers: AskAnswer[] }
  | { kind: 'other' };

interface AskOption {
  label: string;
  preview: string | undefined;
}

export interface AskQuestion {
  question: string;
  kind: AskKind | undefined;
  options: AskOption[] | undefined;
}

const kindOf = (value: unknown): AskKind | undefined => {
  if (value === 'choice' || value === 'approval') {
    return value;
  }

  return undefined;
};

const selectedOf = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || !value.every((label) => typeof label === 'string')) {
    return undefined;
  }

  return value;
};

const answerOf = (value: Record<string, unknown>): AskAnswer => ({
  question: text(value.question),
  selected: selectedOf(value.selected),
  typed: typeof value.typed === 'boolean' ? value.typed : undefined,
});

const answersOf = (value: unknown[]): AskAnswer[] => value.filter(isRecord).map(answerOf);

const optionOf = (value: unknown): AskOption | undefined => {
  if (!isRecord(value) || typeof value.label !== 'string') {
    return undefined;
  }

  return { label: value.label, preview: text(value.preview) };
};

const optionsOf = (value: unknown): AskOption[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((option) => {
    const decoded = optionOf(option);

    return decoded === undefined ? [] : [decoded];
  });
};

const questionOf = (value: unknown): AskQuestion | undefined => {
  if (!isRecord(value) || typeof value.question !== 'string') {
    return undefined;
  }

  return { question: value.question, kind: kindOf(value.kind), options: optionsOf(value.options) };
};

export const askResultOf = (message: Record<string, unknown>): AskResult | undefined => {
  if (message.role !== 'toolResult' || message.toolName !== 'ask_user_question') {
    return undefined;
  }

  if (message.isError === true) {
    return { kind: 'error' };
  }

  const details = message.details;

  if (!isRecord(details)) {
    return { kind: 'other' };
  }

  if (details.kind === 'decided') {
    return { kind: 'decided' };
  }

  if (details.kind === 'answered' && Array.isArray(details.answers)) {
    return {
      kind: 'answered',
      callId: text(message.toolCallId),
      answers: answersOf(details.answers),
    };
  }

  return { kind: 'other' };
};

export const askQuestions = (parameters: Record<string, unknown> | undefined): AskQuestion[] => {
  const questions = parameters?.questions;

  if (!Array.isArray(questions)) {
    return [];
  }

  return questions.flatMap((value) => {
    const decoded = questionOf(value);

    return decoded === undefined ? [] : [decoded];
  });
};
