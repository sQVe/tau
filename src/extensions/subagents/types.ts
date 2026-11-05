import { Type } from 'typebox';
import type { Static } from 'typebox';

import { modelReferencePattern } from '../../config/models.js';
import { instructionSetNames } from '../../instructions/instructions.js';
import type { InstructionSetName } from '../../instructions/instructions.js';
import { stringEnum } from '../../schema.js';

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

export const textLimit = 32_000;
export const text = Type.String({ minLength: 1, maxLength: textLimit });

export const thinkingSchema = stringEnum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const);

export type ThinkingLevel = Static<typeof thinkingSchema>;

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
    instructionSets: Type.Array(stringEnum(instructionSetNames), { maxItems: 4 }),
    ...packageProperties,
  },
  { additionalProperties: false },
);

export const routingSchema = Type.Object(
  {
    shadowPick: text,
    label: Type.Optional(text),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    fallbackReason: Type.Optional(
      stringEnum(['lowConfidence', 'error', 'timeout', 'noRoute', 'unknownLabel']),
    ),
    ticketSent: Type.Boolean(),
    confidenceCutoff: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

const reportFields = {
  outcome: Type.Union([
    Type.Literal('success'),
    Type.Literal('failure'),
    Type.Literal('incomplete'),
  ]),
  summary: text,
  evidence: Type.Array(text, { maxItems: 100 }),
};

export const savedReportSchema = Type.Object(reportFields, { additionalProperties: false });

export type Loadout = Static<typeof loadoutSchema>;
