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

const runNamePattern = `^${nameSegmentPattern}$`;

const itemNamePattern = `^${nameSegmentPattern}(?:/${nameSegmentPattern})*$`;

const runNameSchema = Type.String({ pattern: runNamePattern });

const itemNameSchema = Type.String({ pattern: itemNamePattern });

export const isRunName = (name: string): boolean => new RegExp(runNamePattern, 'u').test(name);

export const isItemName = (name: string): boolean => new RegExp(itemNamePattern, 'u').test(name);

const commandResultSchema = Type.Object(
  {
    // null means the command was killed or timed out.
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    logPath: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

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

const outcomeFields = {
  passed: {},
  differs: { observed: Type.String({ minLength: 1 }) },
  blocked: { reason: Type.String({ minLength: 1 }) },
  notRun: { reason: Type.String({ minLength: 1 }) },
} as const;

export const stepOutcomeSchemas = {
  passed: Type.Object(
    { status: Type.Literal('passed'), ...outcomeFields.passed },
    { additionalProperties: false },
  ),
  differs: Type.Object(
    { status: Type.Literal('differs'), ...outcomeFields.differs },
    { additionalProperties: false },
  ),
  blocked: Type.Object(
    { status: Type.Literal('blocked'), ...outcomeFields.blocked },
    { additionalProperties: false },
  ),
  notRun: Type.Object(
    { status: Type.Literal('notRun'), ...outcomeFields.notRun },
    { additionalProperties: false },
  ),
} as const;

const stepOutcomeSchema = Type.Union([
  stepOutcomeSchemas.passed,
  stepOutcomeSchemas.differs,
  stepOutcomeSchemas.blocked,
  stepOutcomeSchemas.notRun,
]);

export type StepOutcome = Static<typeof stepOutcomeSchema>;

export const artifactSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal('screenshot'), Type.Literal('output'), Type.Literal('trace')]),
    // Relative to the run directory.
    path: Type.String({ minLength: 1, description: 'Relative to the run directory.' }),
  },
  { additionalProperties: false },
);

const stepFields = {
  number: Type.Integer({ minimum: 1 }),
  artifacts: Type.Array(artifactSchema),
};

export const stepSchemas = {
  passed: Type.Object(
    { ...stepFields, status: Type.Literal('passed'), ...outcomeFields.passed },
    { additionalProperties: false },
  ),
  differs: Type.Object(
    { ...stepFields, status: Type.Literal('differs'), ...outcomeFields.differs },
    { additionalProperties: false },
  ),
  blocked: Type.Object(
    { ...stepFields, status: Type.Literal('blocked'), ...outcomeFields.blocked },
    { additionalProperties: false },
  ),
  notRun: Type.Object(
    { ...stepFields, status: Type.Literal('notRun'), ...outcomeFields.notRun },
    { additionalProperties: false },
  ),
} as const;

const stepSchema = Type.Union([
  stepSchemas.passed,
  stepSchemas.differs,
  stepSchemas.blocked,
  stepSchemas.notRun,
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
