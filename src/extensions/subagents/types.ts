import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { modelReferencePattern } from '../../delegateModel/index.js';

export type WorkerState =
  | 'starting'
  | 'running'
  | 'awaitingReply'
  | 'reported'
  | 'stopping'
  | 'stopped'
  | 'cleanupUnconfirmed'
  | 'notOwned';

export interface Profile {
  name: string;
  role: 'investigation' | 'editing';
  model: string | undefined;
  thinking: Loadout['thinking'];
  instructions: string;
  source: string;
}

export const workerNamePattern = '^[a-z][a-z0-9-]{0,31}-[a-z0-9]{2}$';

export const taskIdSchema = Type.String({ pattern: '^[a-zA-Z0-9-]+$' });

export const isTaskId = (value: string): boolean => Value.Check(taskIdSchema, value);

export const textLimit = 32_000;
const text = Type.String({ minLength: 1, maxLength: textLimit });

export const thinkingSchema = StringEnum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const);

export const loadoutSchema = Type.Object(
  {
    harness: Type.Literal('pi'),
    profile: text,
    role: Type.Union([Type.Literal('investigation'), Type.Literal('editing')]),
    model: Type.String({ pattern: modelReferencePattern }),
    thinking: thinkingSchema,
    cwd: text,
    agentDirectory: text,
    permissions: Type.Literal('trusted-full-tools'),
    instructions: text,
  },
  { additionalProperties: false },
);

const taskProperties = {
  taskId: taskIdSchema,
  // Display only. Newer Taus add profiles, so any prefix is accepted.
  name: Type.Optional(Type.String({ pattern: workerNamePattern })),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  predecessorTaskId: Type.Optional(taskIdSchema),
  task: text,
  parentSession: text,
  parentSessionId: text,

  createdAt: Type.Integer({ minimum: 1 }),
  deadline: Type.Integer({ minimum: 1 }),
  cancellationBudget: Type.Integer({ minimum: 1, maximum: 30_000 }),
  monotonicDeadline: Type.Number({ minimum: 1 }),
};

const versionedTaskSchema = <Version extends number>(version: Version) =>
  Type.Object(
    {
      ...taskProperties,
      version: Type.Literal(version),
      nativeSessionId: text,
      nativeSessionFile: text,
      loadout: loadoutSchema,
    },
    { additionalProperties: false },
  );

// Bump for any change to the saved fields, including a new optional field.
export const taskVersion = 3;

export const taskSchema = versionedTaskSchema(taskVersion);

// Non-Pi tasks, saved at version 2 and 3, are retired (ADR 0058).
export const previousTaskSchema = versionedTaskSchema(1);

// Version 2: the Pi worker is its pane's own process, so shellPid equals processId.
export const ownedWorkerSchema = Type.Object(
  {
    version: Type.Literal(2),
    kind: Type.Literal('pi'),
    paneId: text,
    terminalId: text,
    shellPid: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    processId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    startedAt: text,
    token: text,
  },
  { additionalProperties: false },
);

export const reportSchema = Type.Object(
  {
    taskId: text,
    outcome: Type.Union([
      Type.Literal('success'),
      Type.Literal('failure'),
      Type.Literal('incomplete'),
    ]),
    summary: text,
    evidence: Type.Array(text, { maxItems: 100 }),
  },
  { additionalProperties: false },
);

export const eventSchema = Type.Object(
  {
    taskId: text,
    kind: StringEnum([
      'ready',
      'accepted',
      'settled',
      'startupFailure',
      'continuationRefused',
      'cancelled',
      'timeout',
      'cleanup',
      'notified',
      'parentClosed',
      'stopping',
    ]),
    detail: text,
    at: Type.Integer({ minimum: 1 }),
    stopped: Type.Boolean(),
    processId: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const questionIdentitySchema = Type.String({ pattern: '^[a-zA-Z0-9-]{1,128}$' });

const questionIdentity = {
  version: Type.Literal(1),
  taskId: text,
  questionId: questionIdentitySchema,
};

export const questionSchema = Type.Object(
  { ...questionIdentity, question: text },
  { additionalProperties: false },
);

export const replySchema = Type.Object(
  { ...questionIdentity, replyId: questionIdentitySchema, reply: text },
  { additionalProperties: false },
);

// Acknowledgement records worker receipt, not successful application of arbitrary side effects.
export const acknowledgementSchema = Type.Object(
  { ...questionIdentity, replyId: questionIdentitySchema },
  { additionalProperties: false },
);

export type Question = Static<typeof questionSchema>;
export type Reply = Static<typeof replySchema>;
export type Acknowledgement = Static<typeof acknowledgementSchema>;
export type Loadout = Static<typeof loadoutSchema>;
export type Task = Static<typeof taskSchema>;

export type Report = Static<typeof reportSchema>;
export type TaskEvent = Static<typeof eventSchema>;

// A worker with any of these events no longer accepts replies.
export const replyClosedEventKinds: readonly TaskEvent['kind'][] = [
  'settled',
  'startupFailure',
  'cleanup',
  'cancelled',
  'timeout',
];
