import type { Static } from 'typebox';
import { Type } from 'typebox';

const revisionSchema = Type.String({ minLength: 1 });

const exclude = Type.Optional(
  Type.Array(Type.String({ minLength: 1 }), {
    description: 'Paths to leave out of the capture. Each is reported as a gap.',
  }),
);

export const reviewTargetSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('workingTree'), base: revisionSchema, exclude },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('range'), from: revisionSchema, to: revisionSchema, exclude },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('rootCommit'), commit: revisionSchema, exclude },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('files'),
      paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      base: Type.Optional(revisionSchema),
      exclude,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('fix'),
      review: Type.String({
        minLength: 1,
        description: 'The .tau/workers/review-* directory of the earlier capture.',
      }),
      findingPaths: Type.Array(Type.String({ minLength: 1 }), {
        description: 'The repository paths the closed findings cite.',
      }),
      exclude,
    },
    { additionalProperties: false },
  ),
]);

export type ReviewTarget = Static<typeof reviewTargetSchema>;

// A SHA-1 or SHA-256 object name. Git can never read one as an option.
export const objectNameSchema = Type.String({ pattern: '^[0-9a-f]{40}([0-9a-f]{24})?$' });

const excludeSchema = Type.Optional(Type.Array(Type.String({ minLength: 1 })));

// A target after pinTarget, keyed by kind, so a reader can name the field of a bad saved target.
export const pinnedTargetSchemas = {
  workingTree: Type.Object(
    { kind: Type.Literal('workingTree'), base: objectNameSchema, exclude: excludeSchema },
    { additionalProperties: false },
  ),
  range: Type.Object(
    {
      kind: Type.Literal('range'),
      from: objectNameSchema,
      to: objectNameSchema,
      exclude: excludeSchema,
    },
    { additionalProperties: false },
  ),
  rootCommit: Type.Object(
    { kind: Type.Literal('rootCommit'), commit: objectNameSchema, exclude: excludeSchema },
    { additionalProperties: false },
  ),
  files: Type.Object(
    {
      kind: Type.Literal('files'),
      paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      base: objectNameSchema,
      exclude: excludeSchema,
    },
    { additionalProperties: false },
  ),
  fix: Type.Object(
    {
      kind: Type.Literal('fix'),
      review: Type.String({ minLength: 1 }),
      findingPaths: Type.Array(Type.String({ minLength: 1 })),
      base: Type.Union([objectNameSchema, Type.Null()]),
      exclude: excludeSchema,
    },
    { additionalProperties: false },
  ),
};

export const pinnedTargetSchema = Type.Union([
  pinnedTargetSchemas.workingTree,
  pinnedTargetSchemas.range,
  pinnedTargetSchemas.rootCommit,
  pinnedTargetSchemas.files,
  pinnedTargetSchemas.fix,
]);

export type PinnedTarget = Static<typeof pinnedTargetSchema>;
