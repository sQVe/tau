import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { instructionSetNames } from '../../instructionSets.js';
import type { InstructionSetName } from '../../instructionSets.js';
import { modelReferencePattern } from '../../models/models.js';

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
  thinking: Loadout['thinking'];
  tools: string[];
  skills: string[];
  instructionSets: InstructionSetName[];
  packages: string[];
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

// Pi takes the tool allowlist as one comma-separated argument.
export const toolNamePattern = '^[A-Za-z0-9_-]{1,64}$';

const loadoutProperties = {
  harness: Type.Literal('pi'),
  profile: text,
  role: Type.Union([Type.Literal('investigation'), Type.Literal('editing')]),
  model: Type.String({ pattern: modelReferencePattern }),
  thinking: thinkingSchema,
  cwd: text,
  agentDirectory: text,
  permissions: Type.Literal('trusted-full-tools'),
  instructions: text,
};

const toolAndSkillProperties = {
  tools: Type.Array(Type.String({ pattern: toolNamePattern }), { minItems: 1, maxItems: 100 }),
  // SKILL.md paths, not skill names.
  skills: Type.Array(text, { maxItems: 100 }),
};

// Pi package sources as the profile names them, before settings duplicates are skipped.
const packageProperties = { packages: Type.Array(text, { maxItems: 100 }) };

export const loadoutSchema = Type.Object(
  {
    ...loadoutProperties,
    ...toolAndSkillProperties,
    instructionSets: Type.Array(StringEnum(instructionSetNames), { maxItems: 4 }),
    ...packageProperties,
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

// Bump for any change to the saved fields, including a new optional field.
export const taskVersion = 9;

// Version 7 tasks stay readable. They never carry routing. Version 8 routing has no canary.
export const oldestReadableTaskVersion = 7;

const previousRoutingTaskVersion = 8;

const routingFields = {
  shadowPick: text,
  label: Type.Optional(text),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  fallbackReason: Type.Optional(
    StringEnum(['lowConfidence', 'error', 'timeout', 'noRoute', 'unknownLabel']),
  ),
};

const previousRoutingSchema = Type.Object(routingFields, { additionalProperties: false });

const routingSchema = Type.Object(
  { ...routingFields, canary: Type.Boolean() },
  { additionalProperties: false },
);

const taskFields = {
  ...taskProperties,
  nativeSessionId: text,
  nativeSessionFile: text,
  loadout: loadoutSchema,
};

export const taskSchema = Type.Union([
  Type.Object(
    {
      ...taskFields,
      version: Type.Literal(oldestReadableTaskVersion),
      routing: Type.Optional(Type.Never()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...taskFields,
      version: Type.Literal(previousRoutingTaskVersion),
      routing: Type.Optional(previousRoutingSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...taskFields, version: Type.Literal(taskVersion), routing: Type.Optional(routingSchema) },
    { additionalProperties: false },
  ),
]);

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
