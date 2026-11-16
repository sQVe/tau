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
    throw new Error(`record kind ${input.kind} needs a non-blank ${field}.`);
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

export const parseRecordRequest = (input: RecordInput): RecordRequest => {
  const { kind } = input;

  if (kind === undefined) {
    throw new Error('record needs kind.');
  }

  const recordInput = { ...input, kind };

  rejectExtraFields(recordInput);

  switch (recordInput.kind) {
    case 'correction':
      return { kind: 'correction', summary: requireText(recordInput, 'summary') };
    case 'review':
      return {
        kind: 'review',
        pullRequest: requirePullRequest(recordInput),
        outcome: requireText(recordInput, 'outcome'),
      };
    case 'backlog':
      return {
        kind: 'backlog',
        review: requireText(recordInput, 'review'),
        item: requireItem(recordInput),
        summary: requireText(recordInput, 'summary'),
      };
    case 'decision':
      return {
        kind: 'decision',
        review: requireText(recordInput, 'review'),
        item: requireItem(recordInput),
        choice: requireChoice(recordInput),
      };
    default:
      return recordInput.kind satisfies never;
  }
};
