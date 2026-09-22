import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { Static } from 'typebox';

export const textLimit = 32_000;
const text = Type.String({ minLength: 1, maxLength: textLimit });
const strings = Type.Array(text, { maxItems: 200, uniqueItems: true });
export const thinkingSchema = StringEnum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const);
const sharedLoadout = {
  profile: text,
  role: Type.Union([Type.Literal('investigation'), Type.Literal('editing')]),
  thinking: thinkingSchema,
  cwd: text,
  agentDirectory: text,
  permissions: Type.Literal('trusted-full-tools'),
  tools: strings,
  integrations: strings,
  integrationFingerprint: Type.String({ minLength: 64, maxLength: 64 }),
  safetyExtension: text,
  instructions: text,
};
export const piLoadoutSchema = Type.Object(
  {
    ...sharedLoadout,
    harness: Type.Literal('pi'),
    model: Type.String({ pattern: '^[^/\\s]+/[^\\s]+$' }),
    modelFingerprint: Type.String({ minLength: 64, maxLength: 64 }),
    providerFingerprint: Type.String({ minLength: 64, maxLength: 64 }),
    providerFingerprintVersion: Type.Literal(2),
    noExtensions: Type.Boolean(),
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
    reportDirectory: text,
    configurationApproved: Type.Optional(Type.Literal(true)),
    instructions: text,
  },
  { additionalProperties: false },
);
export const loadoutSchema = Type.Union([piLoadoutSchema, genericLoadoutSchema]);
export const treeSchema = Type.Object(
  {
    rootSession: text,
    rootSessionId: text,
    parentTaskId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9-]+$' })),
    monotonicDeadline: Type.Number({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const taskProperties = {
  taskId: Type.String({ pattern: '^[a-zA-Z0-9-]+$' }),
  name: Type.Optional(Type.String({ pattern: '^(worker|investigator)-[a-z0-9]{2}$' })),
  predecessorTaskId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9-]+$' })),
  task: text,
  parentSession: text,
  parentSessionId: text,
  ownerId: text,

  createdAt: Type.Integer({ minimum: 1 }),
  deadline: Type.Integer({ minimum: 1 }),
  cancellationBudget: Type.Integer({ minimum: 1, maximum: 30_000 }),
  tree: treeSchema,
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
export const successorSchema = Type.Object(
  {
    version: Type.Literal(1),
    predecessorTaskId: Type.String({ pattern: '^[a-zA-Z0-9-]+$' }),
    successorTaskId: Type.String({ pattern: '^[a-zA-Z0-9-]+$' }),
    nativeSessionId: text,
    nativeSessionFile: text,
  },
  { additionalProperties: false },
);
export type Successor = Static<typeof successorSchema>;

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
export type WorkerState =
  | 'starting'
  | 'running'
  | 'awaitingReply'
  | 'reported'
  | 'stopping'
  | 'stopped'
  | 'cleanupUnconfirmed'
  | 'notOwned';
export type Question = Static<typeof questionSchema>;
export type Reply = Static<typeof replySchema>;
export type Acknowledgement = Static<typeof acknowledgementSchema>;
export type Loadout = Static<typeof loadoutSchema>;
export type PiLoadout = Static<typeof piLoadoutSchema>;
export type GenericLoadout = Static<typeof genericLoadoutSchema>;
export type Harness = string;
export const isGenericLoadout = (loadout: Loadout): loadout is GenericLoadout =>
  loadout.harness === 'generic';
export const isPiLoadout = (loadout: Loadout): loadout is PiLoadout => loadout.harness === 'pi';
export const harnessOf = (loadout: Loadout): Harness =>
  isGenericLoadout(loadout) ? loadout.kind : loadout.harness;
export type Task = Static<typeof taskSchema>;
export type NativeTask = Extract<Task, { version: 1 }>;
export const requireNativeTask = (task: Task): NativeTask => {
  if (task.version !== 1) {
    throw new Error('This task has no reproducible Pi native session.');
  }

  return task;
};
export type Report = Static<typeof reportSchema>;
export type TaskEvent = Static<typeof eventSchema>;

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
