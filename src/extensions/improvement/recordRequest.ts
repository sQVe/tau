import { isAbsolute } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';

import { stringEnum } from '../../schema.js';

type RecordKind = 'correction' | 'review' | 'backlog' | 'decision';

type TextField = 'summary' | 'pullRequest' | 'outcome' | 'review';

type Choice = 'approved' | 'rejected' | 'redirected';

export type RecordRequest =
  | { action: 'record'; kind: 'correction'; summary: string }
  | {
      action: 'record';
      kind: 'review';
      projectRoot: string;
      pullRequest: string;
      outcome: string;
    }
  | {
      action: 'record';
      kind: 'backlog';
      projectRoot: string;
      review: string;
      item: number;
      summary: string;
    }
  | {
      action: 'record';
      kind: 'decision';
      projectRoot: string;
      review: string;
      item: number;
      choice: Choice;
    }
  | { action: 'task'; pullRequest: string; worktree: string }
  | { action: 'status' };

export type TaskRequest = Extract<RecordRequest, { action: 'task' }>;

export const parameters = Type.Object({
  action: stringEnum(['record', 'status', 'task']),
  kind: Type.Optional(stringEnum(['correction', 'review', 'backlog', 'decision'])),
  summary: Type.Optional(Type.String()),
  pullRequest: Type.Optional(Type.String()),
  outcome: Type.Optional(Type.String()),
  review: Type.Optional(Type.String()),
  item: Type.Optional(Type.Integer({ minimum: 1 })),
  choice: Type.Optional(stringEnum(['approved', 'rejected', 'redirected'])),
  worktree: Type.Optional(Type.String()),
  projectRoot: Type.Optional(Type.String()),
});

export type RecordInput = Static<typeof parameters>;

const fieldsByKind: Readonly<Record<RecordKind, readonly string[]>> = {
  correction: ['summary'],
  review: ['projectRoot', 'pullRequest', 'outcome'],
  backlog: ['projectRoot', 'review', 'item', 'summary'],
  decision: ['projectRoot', 'review', 'item', 'choice'],
};

const rejectExtraFields = (input: RecordInput, kind: RecordKind): void => {
  const allowed = fieldsByKind[kind];

  for (const field of Object.keys(input)) {
    if (field === 'action' || field === 'kind' || allowed.includes(field)) {
      continue;
    }

    throw new Error(`record kind ${kind} does not take ${field}.`);
  }
};

const requireText = (input: RecordInput, kind: RecordKind, field: TextField): string => {
  const value = input[field];

  if (value === undefined) {
    throw new Error(`record kind ${kind} needs ${field}.`);
  }

  if (value.trim() === '') {
    throw new Error(`record kind ${kind} needs a non-blank ${field}.`);
  }

  return value;
};

const requirePullRequest = (input: RecordInput, kind: RecordKind): string => {
  const value = requireText(input, kind, 'pullRequest');

  if (!value.startsWith('https://')) {
    throw new Error(`record kind ${kind} pullRequest must start with https://.`);
  }

  return value;
};

const requireItem = (input: RecordInput, kind: RecordKind): number => {
  const value = input.item;

  if (value === undefined) {
    throw new Error(`record kind ${kind} needs item.`);
  }

  return value;
};

const requireChoice = (input: RecordInput, kind: RecordKind): Choice => {
  const value = input.choice;

  if (value === undefined) {
    throw new Error(`record kind ${kind} needs choice.`);
  }

  return value;
};

const requireAbsolutePath = (
  value: string | undefined,
  prefix: string,
  field: 'worktree' | 'projectRoot',
): string => {
  if (value === undefined) {
    throw new Error(`${prefix} needs ${field}.`);
  }

  if (value.trim() === '') {
    throw new Error(`${prefix} needs a non-blank ${field}.`);
  }

  if (!isAbsolute(value)) {
    throw new Error(`${prefix} ${field} must be absolute.`);
  }

  return value;
};

const parseRecord = (input: RecordInput): RecordRequest => {
  const kind = input.kind;

  if (kind === undefined) {
    throw new Error('record needs kind.');
  }

  rejectExtraFields(input, kind);

  switch (kind) {
    case 'correction':
      return { action: 'record', kind: 'correction', summary: requireText(input, kind, 'summary') };
    case 'review':
      return {
        action: 'record',
        kind: 'review',
        projectRoot: requireAbsolutePath(input.projectRoot, `record kind ${kind}`, 'projectRoot'),
        pullRequest: requirePullRequest(input, kind),
        outcome: requireText(input, kind, 'outcome'),
      };
    case 'backlog':
      return {
        action: 'record',
        kind: 'backlog',
        projectRoot: requireAbsolutePath(input.projectRoot, `record kind ${kind}`, 'projectRoot'),
        review: requireText(input, kind, 'review'),
        item: requireItem(input, kind),
        summary: requireText(input, kind, 'summary'),
      };
    case 'decision':
      return {
        action: 'record',
        kind: 'decision',
        projectRoot: requireAbsolutePath(input.projectRoot, `record kind ${kind}`, 'projectRoot'),
        review: requireText(input, kind, 'review'),
        item: requireItem(input, kind),
        choice: requireChoice(input, kind),
      };
    default:
      return kind satisfies never;
  }
};

const taskFields = new Set(['pullRequest', 'worktree']);

const rejectTaskExtraFields = (input: RecordInput): void => {
  for (const field of Object.keys(input)) {
    if (field === 'action' || taskFields.has(field)) {
      continue;
    }

    throw new Error(`task does not take ${field}.`);
  }
};

const requireTaskText = (input: RecordInput, field: 'pullRequest'): string => {
  const value = input[field];

  if (value === undefined) {
    throw new Error(`task needs ${field}.`);
  }

  if (value.trim() === '') {
    throw new Error(`task needs a non-blank ${field}.`);
  }

  return value;
};

const parseTask = (input: RecordInput): RecordRequest => {
  rejectTaskExtraFields(input);

  return {
    action: 'task',
    pullRequest: requireTaskText(input, 'pullRequest'),
    worktree: requireAbsolutePath(input.worktree, 'task', 'worktree'),
  };
};

export const parseRecordRequest = (input: RecordInput): RecordRequest => {
  switch (input.action) {
    case 'record':
      return parseRecord(input);
    case 'task':
      return parseTask(input);
    case 'status':
      return { action: 'status' };
    default:
      return input.action satisfies never;
  }
};
