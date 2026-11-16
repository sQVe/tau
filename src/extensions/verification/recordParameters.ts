import { Type } from 'typebox';
import type { Static, TObject, TProperties } from 'typebox';

import { artifactSchema, stepOutcomeSchemas } from '../../verification/records.js';

const withArtifacts = <Properties extends TProperties>(schema: TObject<Properties>) =>
  Type.Object(
    {
      ...schema.properties,
      artifacts: Type.Array(artifactSchema, {
        description: 'Artifacts for this step; may be empty.',
      }),
    },
    { additionalProperties: false },
  );

const stepResultSchema = Type.Union([
  withArtifacts(stepOutcomeSchemas.passed),
  withArtifacts(stepOutcomeSchemas.differs),
  withArtifacts(stepOutcomeSchemas.blocked),
  withArtifacts(stepOutcomeSchemas.notRun),
]);

const endStateSchema = Type.Union([
  stepOutcomeSchemas.passed,
  stepOutcomeSchemas.differs,
  stepOutcomeSchemas.blocked,
  stepOutcomeSchemas.notRun,
]);

export const recordParameters = Type.Object(
  {
    run: Type.String({ description: 'Verification run name.' }),
    item: Type.String({ description: 'Item name registered in the run.' }),
    steps: Type.Array(stepResultSchema, {
      description: 'One result per registered step, in order.',
    }),
    endState: Type.Optional(endStateSchema),
  },
  { additionalProperties: false },
);

export type RecordInput = Static<typeof recordParameters>;
