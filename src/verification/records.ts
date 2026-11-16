import { Type } from 'typebox';
import type { Static } from 'typebox';

export type RecordRead<Value> =
  | { status: 'valid'; record: Value }
  | { status: 'missing' }
  | { status: 'malformed'; problem: string };

export interface ItemRead {
  item: string;
  path: string;
  read: RecordRead<ItemRecord>;
}

export interface RunRead {
  run: string;
  directory: string;
  read: RecordRead<RunRecord>;
  items: ItemRead[];
}

export const runRecordVersion = 1;
export const itemRecordVersion = 1;

const nameSegmentPattern = '[A-Za-z0-9][A-Za-z0-9._-]*';

export const runNameSchema = Type.String({ pattern: `^${nameSegmentPattern}$` });

export const itemNameSchema = Type.String({
  pattern: `^${nameSegmentPattern}(?:/${nameSegmentPattern})*$`,
});

export const commandResultSchema = Type.Object(
  {
    // null means the command was killed or timed out.
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    logPath: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type CommandResult = Static<typeof commandResultSchema>;

const platformSchema = Type.Object(
  {
    os: Type.String({ minLength: 1 }),
    arch: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const registeredItemSchema = Type.Object(
  {
    item: itemNameSchema,
    steps: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const runRecordSchema = Type.Object(
  {
    version: Type.Literal(runRecordVersion),
    run: runNameSchema,
    target: Type.String({ minLength: 1 }),
    head: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    dirty: Type.Boolean(),
    platform: platformSchema,
    startedAt: Type.String(),
    treeAtLaunch: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    treeAtStop: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    launch: Type.Union([commandResultSchema, Type.Null()]),
    doctor: Type.Union([commandResultSchema, Type.Null()]),
    stop: Type.Union([commandResultSchema, Type.Null()]),
    items: Type.Array(registeredItemSchema),
  },
  { additionalProperties: false },
);

export type RunRecord = Static<typeof runRecordSchema>;

export const stepOutcomeSchema = Type.Union([
  Type.Object({ status: Type.Literal('passed') }, { additionalProperties: false }),
  Type.Object(
    { status: Type.Literal('differs'), observed: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { status: Type.Literal('blocked'), reason: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { status: Type.Literal('notRun'), reason: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

export type StepOutcome = Static<typeof stepOutcomeSchema>;

export const artifactSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal('screenshot'), Type.Literal('output'), Type.Literal('trace')]),
    // Relative to the run directory.
    path: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type Artifact = Static<typeof artifactSchema>;

const stepFields = {
  number: Type.Integer({ minimum: 1 }),
  artifacts: Type.Array(artifactSchema),
};

export const stepSchema = Type.Union([
  Type.Object({ ...stepFields, status: Type.Literal('passed') }, { additionalProperties: false }),
  Type.Object(
    { ...stepFields, status: Type.Literal('differs'), observed: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...stepFields, status: Type.Literal('blocked'), reason: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...stepFields, status: Type.Literal('notRun'), reason: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

export type Step = Static<typeof stepSchema>;

export const itemRecordSchema = Type.Object(
  {
    version: Type.Literal(itemRecordVersion),
    run: runNameSchema,
    item: itemNameSchema,
    drive: Type.Union([Type.Literal('hand'), Type.Literal('script')]),
    steps: Type.Array(stepSchema, { minItems: 1 }),
    endState: stepOutcomeSchema,
  },
  { additionalProperties: false },
);

export type ItemRecord = Static<typeof itemRecordSchema>;
