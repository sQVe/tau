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
    // Records saved before Claude support carry no harness and remain Pi tasks.
    harness: Type.Optional(Type.Literal('pi')),
    model: Type.String({ pattern: '^[^/\\s]+/[^\\s]+$' }),
    modelFingerprint: Type.String({ minLength: 64, maxLength: 64 }),
    providerFingerprint: Type.String({ minLength: 64, maxLength: 64 }),
    // Missing versions retain the original credential-sensitive fingerprint semantics.
    providerFingerprintVersion: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])),
    // Older version 1 tasks lack this audit field; startup still replays the saved integrations.
    noExtensions: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export const claudeLoadoutSchema = Type.Object(
  {
    ...sharedLoadout,
    harness: Type.Literal('claude'),
    model: Type.String({ pattern: '^[^\\s]+$' }),
    // Claude resolves its own credentials; Tau records the launched binary instead of a provider fingerprint.
    executable: text,
    executableVersion: text,
    // Tau never passes a permission flag. This records the mode the worker must report at runtime.
    permissionMode: Type.Literal('bypassPermissions'),
    safetyArguments: Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 }),
    channelExecutable: text,
    channelScript: text,
  },
  { additionalProperties: false },
);
export const loadoutSchema = Type.Union([piLoadoutSchema, claudeLoadoutSchema]);
export const treeSchema = Type.Object(
  {
    rootSession: text,
    rootSessionId: text,
    parentTaskId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9-]+$' })),
    monotonicDeadline: Type.Number({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export const taskSchema = Type.Object(
  {
    version: Type.Literal(1),
    taskId: Type.String({ pattern: '^[a-zA-Z0-9-]+$' }),
    name: Type.Optional(Type.String({ pattern: '^(worker|investigator)-[a-z0-9]{2}$' })),
    predecessorTaskId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9-]+$' })),
    task: text,
    parentSession: text,
    parentSessionId: text,
    ownerId: text,
    nativeSessionId: text,
    nativeSessionFile: text,
    createdAt: Type.Integer({ minimum: 1 }),
    deadline: Type.Integer({ minimum: 1 }),
    cancellationBudget: Type.Integer({ minimum: 1, maximum: 30_000 }),
    tree: Type.Optional(treeSchema),
    loadout: loadoutSchema,
  },
  { additionalProperties: false },
);
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
export type Question = Static<typeof questionSchema>;
export type Reply = Static<typeof replySchema>;
export type Acknowledgement = Static<typeof acknowledgementSchema>;
export type Loadout = Static<typeof loadoutSchema>;
export type PiLoadout = Static<typeof piLoadoutSchema>;
export type ClaudeLoadout = Static<typeof claudeLoadoutSchema>;
export type Harness = 'pi' | 'claude';
export const harnessOf = (loadout: Loadout): Harness => loadout.harness ?? 'pi';
export const isClaudeLoadout = (loadout: Loadout): loadout is ClaudeLoadout =>
  loadout.harness === 'claude';
export type Task = Static<typeof taskSchema>;
export type Report = Static<typeof reportSchema>;
export type TaskEvent = Static<typeof eventSchema>;
export interface Profile {
  name: string;
  role: 'investigation' | 'editing';
  harness: Harness;
  harnessSpecified?: boolean;
  model: string | undefined;
  thinking: Loadout['thinking'];
  thinkingSpecified?: boolean;
  instructions: string;
  source: string;
}
