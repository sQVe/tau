import type { Static } from 'typebox';
import { Type } from 'typebox';

import { stringEnum } from '../../schema.js';

type RecordKind = 'correction' | 'review' | 'backlog' | 'decision';

type TextField = 'summary' | 'pullRequest' | 'outcome' | 'review';

type Choice = 'approved' | 'rejected' | 'redirected';

export type RecordRequest =
  | { kind: 'correction'; summary: string }
  | { kind: 'review'; pullRequest: string; outcome: string }
  | { kind: 'backlog'; review: string; item: number; summary: string }
  | { kind: 'decision'; review: string; item: number; choice: Choice };

export const parameters = Type.Object({
  action: stringEnum(['record', 'status']),
  kind: Type.Optional(stringEnum(['correction', 'review', 'backlog', 'decision'])),
  summary: Type.Optional(Type.String()),
  pullRequest: Type.Optional(Type.String()),
  outcome: Type.Optional(Type.String()),
  review: Type.Optional(Type.String()),
  item: Type.Optional(Type.Integer({ minimum: 1 })),
  choice: Type.Optional(stringEnum(['approved', 'rejected', 'redirected'])),
});

export type RecordInput = Static<typeof parameters>;

type KindedInput = RecordInput & { kind: RecordKind };

const fieldsByKind: Readonly<Record<RecordKind, readonly string[]>> = {
  correction: ['summary'],
  review: ['pullRequest', 'outcome'],
  backlog: ['review', 'item', 'summary'],
  decision: ['review', 'item', 'choice'],
};

const rejectExtraFields = (input: KindedInput): void => {
  const allowed = fieldsByKind[input.kind];

  for (const field of Object.keys(input)) {
    if (field === 'action' || field === 'kind' || allowed.includes(field)) {
      continue;
    }

    throw new Error(`record kind ${input.kind} does not take ${field}.`);
  }
};

const requireText = (input: KindedInput, field: TextField): string => {
  const value = input[field];

  if (value === undefined) {
    throw new Error(`record kind ${input.kind} needs ${field}.`);
  }

  if (value.trim() === '') {
    throw new Error(`record kind ${input.kind} needs ${field}.`);
  }

  return value;
};

const requirePullRequest = (input: KindedInput): string => {
  const value = requireText(input, 'pullRequest');

  if (!value.startsWith('https://')) {
    throw new Error(`record kind ${input.kind} pullRequest must start with https://.`);
  }

  return value;
};

const requireItem = (input: KindedInput): number => {
  const value = input.item;

  if (value === undefined) {
    throw new Error(`record kind ${input.kind} needs item.`);
  }

  return value;
};

const requireChoice = (input: KindedInput): Choice => {
  const value = input.choice;

  if (value === undefined) {
    throw new Error(`record kind ${input.kind} needs choice.`);
  }

  return value;
};

const parseCorrection = (input: KindedInput): RecordRequest => ({
  kind: 'correction',
  summary: requireText(input, 'summary'),
});

const parseReview = (input: KindedInput): RecordRequest => ({
  kind: 'review',
  pullRequest: requirePullRequest(input),
  outcome: requireText(input, 'outcome'),
});

const parseBacklog = (input: KindedInput): RecordRequest => ({
  kind: 'backlog',
  review: requireText(input, 'review'),
  item: requireItem(input),
  summary: requireText(input, 'summary'),
});

const parseDecision = (input: KindedInput): RecordRequest => ({
  kind: 'decision',
  review: requireText(input, 'review'),
  item: requireItem(input),
  choice: requireChoice(input),
});

const parsers: Readonly<Record<RecordKind, (input: KindedInput) => RecordRequest>> = {
  correction: parseCorrection,
  review: parseReview,
  backlog: parseBacklog,
  decision: parseDecision,
};

export const parseRecordRequest = (input: RecordInput): RecordRequest => {
  const { kind } = input;

  if (kind === undefined) {
    throw new Error('record needs kind.');
  }

  const recordInput = { ...input, kind };

  rejectExtraFields(recordInput);

  return parsers[kind](recordInput);
};
