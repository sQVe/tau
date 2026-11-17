import { isAbsolute } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { ClassLevel, ProposedClass } from '../../improvement/correctDecision.js';
import { stringEnum } from '../../schema.js';

type RecordKind = 'correction' | 'review' | 'backlog' | 'decision' | 'pass' | 'class';

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
  | {
      action: 'record';
      kind: 'decision';
      projectRoot: string;
      class: string;
      choice: Choice;
    }
  | { action: 'record'; kind: 'pass' }
  | {
      action: 'record';
      kind: 'class';
      projectRoot: string;
      identity: string;
      level: ClassLevel;
      summary: string;
      occurrences: string[];
    }
  | { action: 'task'; pullRequest: string; worktree: string }
  | { action: 'status' }
  | { action: 'correct'; classes?: ProposedClass[] }
  | { action: 'history'; projectRoots: string[]; pullRequests: string[] };

export type TaskRequest = Extract<RecordRequest, { action: 'task' }>;

const classLevels = ['architecture', 'type', 'lint', 'test', 'prose'] as const;

const classIdentityPattern = /^[a-z0-9][a-z0-9-]{0,99}$/u;

const proposedClassParameters = Type.Object({
  identity: Type.String(),
  level: stringEnum(classLevels),
  summary: Type.String(),
  occurrences: Type.Array(Type.String(), { minItems: 1 }),
  reverted: Type.Boolean(),
  qaMiss: Type.Boolean(),
});

type ProposedClassInput = Static<typeof proposedClassParameters>;

export const parameters = Type.Object({
  action: stringEnum(['record', 'status', 'task', 'correct', 'history']),
  kind: Type.Optional(stringEnum(['correction', 'review', 'backlog', 'decision', 'pass', 'class'])),
  summary: Type.Optional(Type.String()),
  pullRequest: Type.Optional(Type.String()),
  outcome: Type.Optional(Type.String()),
  review: Type.Optional(Type.String()),
  item: Type.Optional(Type.Integer({ minimum: 1 })),
  choice: Type.Optional(stringEnum(['approved', 'rejected', 'redirected'])),
  worktree: Type.Optional(Type.String()),
  projectRoot: Type.Optional(Type.String()),
  identity: Type.Optional(Type.String()),
  level: Type.Optional(stringEnum(classLevels)),
  occurrences: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  class: Type.Optional(Type.String()),
  classes: Type.Optional(Type.Array(proposedClassParameters)),
  projectRoots: Type.Optional(Type.Array(Type.String())),
  pullRequests: Type.Optional(Type.Array(Type.String())),
});

export type RecordInput = Static<typeof parameters>;

const fieldsByKind: Readonly<Record<RecordKind, readonly string[]>> = {
  correction: ['summary'],
  review: ['projectRoot', 'pullRequest', 'outcome'],
  backlog: ['projectRoot', 'review', 'item', 'summary'],
  decision: ['projectRoot', 'review', 'item', 'choice', 'class'],
  pass: [],
  class: ['projectRoot', 'identity', 'level', 'summary', 'occurrences'],
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

const requireClassIdentity = (value: string | undefined, context: string): string => {
  if (value === undefined) {
    throw new Error(`${context} needs identity.`);
  }

  if (value.trim() === '') {
    throw new Error(`${context} needs a non-blank identity.`);
  }

  if (!classIdentityPattern.test(value)) {
    throw new Error(`${context} identity must be kebab-case.`);
  }

  return value;
};

const isClassLevel = (value: string): value is ClassLevel =>
  classLevels.some((level) => level === value);

const requireClassLevel = (value: string | undefined, context: string): ClassLevel => {
  if (value === undefined) {
    throw new Error(`${context} needs level.`);
  }

  if (!isClassLevel(value)) {
    throw new Error(`${context} level must be architecture, type, lint, test, or prose.`);
  }

  return value;
};

const requireClassSummary = (value: string | undefined, context: string): string => {
  if (value === undefined) {
    throw new Error(`${context} needs summary.`);
  }

  if (value.trim() === '') {
    throw new Error(`${context} needs a non-blank summary.`);
  }

  return value;
};

const requireOccurrences = (value: readonly string[] | undefined, context: string): string[] => {
  if (value === undefined || value.length === 0) {
    throw new Error(`${context} needs occurrences.`);
  }

  for (const [index, occurrence] of value.entries()) {
    if (occurrence.trim() === '') {
      throw new Error(`${context} occurrence ${index + 1} must be non-blank.`);
    }
  }

  return [...value];
};

const requireClassFlag = (
  value: boolean | undefined,
  context: string,
  field: 'reverted' | 'qaMiss',
): boolean => {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${context} needs ${field}.`);
  }

  return value;
};

const parseClass = (input: RecordInput): Extract<RecordRequest, { kind: 'class' }> => {
  const context = 'record kind class';

  return {
    action: 'record',
    kind: 'class',
    projectRoot: requireAbsolutePath(input.projectRoot, context, 'projectRoot'),
    identity: requireClassIdentity(input.identity, context),
    level: requireClassLevel(input.level, context),
    summary: requireClassSummary(input.summary, context),
    occurrences: requireOccurrences(input.occurrences, context),
  };
};

const parseProposedClass = (input: ProposedClassInput, context: string): ProposedClass => ({
  identity: requireClassIdentity(input.identity, context),
  level: requireClassLevel(input.level, context),
  summary: requireClassSummary(input.summary, context),
  occurrences: requireOccurrences(input.occurrences, context),
  reverted: requireClassFlag(input.reverted, context, 'reverted'),
  qaMiss: requireClassFlag(input.qaMiss, context, 'qaMiss'),
});

const parseDecision = (input: RecordInput): RecordRequest => {
  const context = 'record kind decision';

  if (input.review !== undefined && input.class !== undefined) {
    throw new Error(`${context} takes review or class, not both.`);
  }

  if (input.class !== undefined) {
    if (input.item !== undefined) {
      throw new Error(`${context} with class does not take item.`);
    }

    const classEventId = input.class.trim() === '' ? undefined : input.class;

    if (classEventId === undefined) {
      throw new Error(`${context} needs a class event ID.`);
    }

    return {
      action: 'record',
      kind: 'decision',
      projectRoot: requireAbsolutePath(input.projectRoot, context, 'projectRoot'),
      class: classEventId,
      choice: requireChoice(input, 'decision'),
    };
  }

  return {
    action: 'record',
    kind: 'decision',
    projectRoot: requireAbsolutePath(input.projectRoot, context, 'projectRoot'),
    review: requireText(input, 'decision', 'review'),
    item: requireItem(input, 'decision'),
    choice: requireChoice(input, 'decision'),
  };
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
      return parseDecision(input);
    case 'pass':
      return { action: 'record', kind: 'pass' };
    case 'class':
      return parseClass(input);
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

const correctFields = new Set(['action', 'classes']);

const rejectCorrectExtraFields = (input: RecordInput): void => {
  for (const field of Object.keys(input)) {
    if (correctFields.has(field)) {
      continue;
    }

    throw new Error(`correct does not take ${field}.`);
  }
};

const parseCorrect = (input: RecordInput): RecordRequest => {
  rejectCorrectExtraFields(input);

  if (input.classes === undefined) {
    return { action: 'correct' };
  }

  return {
    action: 'correct',
    classes: input.classes.map((entry, index) =>
      parseProposedClass(entry, `correct classes[${index + 1}]`),
    ),
  };
};

const historyFields = new Set(['action', 'projectRoots', 'pullRequests']);

const rejectHistoryExtraFields = (input: RecordInput): void => {
  for (const field of Object.keys(input)) {
    if (historyFields.has(field)) {
      continue;
    }

    throw new Error(`history does not take ${field}.`);
  }
};

const requireHistoryRoots = (value: readonly string[] | undefined): string[] => {
  if (value === undefined) {
    throw new Error('history needs projectRoots.');
  }

  for (const [index, projectRoot] of value.entries()) {
    if (projectRoot.trim() === '') {
      throw new Error(`history projectRoots[${index + 1}] must be non-blank.`);
    }

    if (!isAbsolute(projectRoot)) {
      throw new Error(`history projectRoots[${index + 1}] must be absolute.`);
    }
  }

  return [...value];
};

const requireHistoryPullRequests = (value: readonly string[] | undefined): string[] => {
  if (value === undefined) {
    throw new Error('history needs pullRequests.');
  }

  for (const [index, pullRequest] of value.entries()) {
    if (pullRequest.trim() === '') {
      throw new Error(`history pullRequests[${index + 1}] must be non-blank.`);
    }
  }

  return [...value];
};

const parseHistory = (input: RecordInput): RecordRequest => {
  rejectHistoryExtraFields(input);

  return {
    action: 'history',
    projectRoots: requireHistoryRoots(input.projectRoots),
    pullRequests: requireHistoryPullRequests(input.pullRequests),
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
    case 'correct':
      return parseCorrect(input);
    case 'history':
      return parseHistory(input);
    default:
      return input.action satisfies never;
  }
};
