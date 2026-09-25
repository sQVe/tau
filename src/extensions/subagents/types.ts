import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { Static } from 'typebox';

export type WorkerState =
  | 'starting'
  | 'running'
  | 'awaitingReply'
  | 'reported'
  | 'stopping'
  | 'stopped'
  | 'cleanupUnconfirmed'
  | 'notOwned';

export type Harness = string;

export type NativeTask = Extract<Task, { version: 1 }>;

export type SubmissionState = 'submitted' | 'not-delivered' | 'uncertain';

export type ReplyDelivery = 'sent' | 'uncertain' | 'notResent' | 'notDelivered';

export interface Profile {
  name: string;
  role: 'investigation' | 'editing';
  harness: Harness;
  harnessSpecified?: boolean;
  model: string | undefined;
  thinking: PiLoadout['thinking'];
  thinkingSpecified?: boolean;
  instructions: string;
  source: string;
}

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

const piLoadoutSchema = Type.Object(
  {
    harness: Type.Literal('pi'),
    profile: text,
    role: Type.Union([Type.Literal('investigation'), Type.Literal('editing')]),
    model: Type.String({ pattern: '^[^/\\s]+/[^\\s]+$' }),
    thinking: thinkingSchema,
    cwd: text,
    agentDirectory: text,
    permissions: Type.Literal('trusted-full-tools'),
    instructions: text,
  },
  { additionalProperties: false },
);

export const genericLoadoutSchema = Type.Object(
  {
    harness: Type.Literal('generic'),
    kind: Type.String({ pattern: '^[a-z][a-z0-9-]*$', maxLength: 64 }),
    profile: text,
    role: Type.Union([Type.Literal('investigation'), Type.Literal('editing')]),
    cwd: text,
    permissions: Type.Literal('native-controls'),
    arguments: Type.Array(Type.String({ maxLength: 8000, pattern: '^[^\\u0000]*$' }), {
      maxItems: 100,
    }),
    requestedModel: Type.Optional(text),
    configurationApproved: Type.Optional(Type.Literal(true)),
    instructions: text,
  },
  { additionalProperties: false },
);

export const loadoutSchema = Type.Union([piLoadoutSchema, genericLoadoutSchema]);

const taskProperties = {
  taskId: Type.String({ pattern: '^[a-zA-Z0-9-]+$' }),
  name: Type.Optional(
    Type.String({ pattern: '^(worker|scout|reviewer|investigator)-[a-z0-9]{2}$' }),
  ),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  predecessorTaskId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9-]+$' })),
  task: text,
  parentSession: text,
  parentSessionId: text,

  createdAt: Type.Integer({ minimum: 1 }),
  deadline: Type.Integer({ minimum: 1 }),
  cancellationBudget: Type.Integer({ minimum: 1, maximum: 30_000 }),
  monotonicDeadline: Type.Number({ minimum: 1 }),
};

export const taskSchema = Type.Union([
  Type.Object(
    {
      ...taskProperties,
      version: Type.Literal(1),
      nativeSessionId: text,
      nativeSessionFile: text,
      loadout: piLoadoutSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...taskProperties,
      version: Type.Literal(2),
      nativeSessionId: Type.Optional(Type.Never()),
      nativeSessionFile: Type.Optional(Type.Never()),
      loadout: genericLoadoutSchema,
    },
    { additionalProperties: false },
  ),
]);

const ownedWorkerProperties = {
  paneId: text,
  terminalId: text,
  shellPid: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  processId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  startedAt: text,
  nativeReference: Type.Optional(Type.Object({ kind: text, value: text })),
};

export const ownedWorkerSchema = Type.Union([
  Type.Object(
    { ...ownedWorkerProperties, kind: Type.Literal('pi'), token: text },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ownedWorkerProperties,
      kind: Type.Literal('generic'),
      agentKind: text,
      shellStartedAt: text,
    },
    { additionalProperties: false },
  ),
]);

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
export type PiLoadout = Static<typeof piLoadoutSchema>;
export type GenericLoadout = Static<typeof genericLoadoutSchema>;

export const isGenericLoadout = (loadout: Loadout): loadout is GenericLoadout =>
  loadout.harness === 'generic';

export const isPiLoadout = (loadout: Loadout): loadout is PiLoadout => loadout.harness === 'pi';

export const harnessOf = (loadout: Loadout): Harness =>
  isGenericLoadout(loadout) ? loadout.kind : loadout.harness;

export type Task = Static<typeof taskSchema>;

export const requireNativeTask = (task: Task): NativeTask => {
  if (task.version !== 1) {
    throw new Error('This task has no reproducible Pi native session.');
  }

  return task;
};

export type Report = Static<typeof reportSchema>;
export type TaskEvent = Static<typeof eventSchema>;

export const nativeAgentStates = ['idle', 'done', 'working', 'blocked', 'unknown'] as const;

export type NativeAgentState = (typeof nativeAgentStates)[number];

// These events end the task even when no report was saved.
export const taskEndedEventKinds: readonly TaskEvent['kind'][] = [
  'cleanup',
  'cancelled',
  'timeout',
  'startupFailure',
  'parentClosed',
  'settled',
  'stopping',
];

// A worker with any of these events no longer accepts replies.
export const replyClosedEventKinds: readonly TaskEvent['kind'][] = [
  'settled',
  'startupFailure',
  'cleanup',
  'cancelled',
  'timeout',
];
