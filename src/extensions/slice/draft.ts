import { join } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';

import { readOptionalText, readVersionedRecord, writeRecord } from '../../record.js';
import { blockerProblem } from './blockers.js';

export interface Draft {
  plan: Plan;
  containerBody: string;
  sliceBodies: string[];
}

export const planFileName = 'plan.json';

const currentVersion = 1;

const identifierSchema = Type.String({ pattern: '^[A-Z][A-Z0-9]*-[0-9]+$' });
const bodyFileSchema = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*\\.md$' });
const titleSchema = Type.String({ minLength: 1, pattern: '\\S' });

const planSchema = Type.Object(
  {
    version: Type.Literal(currentVersion),
    route: Type.Object(
      {
        team: Type.String({ minLength: 1 }),
        project: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    container: Type.Object(
      {
        identifier: Type.Union([identifierSchema, Type.Null()]),
        title: titleSchema,
        file: bodyFileSchema,
      },
      { additionalProperties: false },
    ),
    slices: Type.Array(
      Type.Object(
        {
          identifier: Type.Union([identifierSchema, Type.Null()]),
          title: titleSchema,
          file: bodyFileSchema,
          blockedBy: Type.Array(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type Plan = Static<typeof planSchema>;

// Apply writes one Linear issue per identifier, so a repeated identifier would write one issue twice.
const rejectRepeatedIdentifiers = (path: string, plan: Plan) => {
  const identifiers = new Set<string>();

  for (const { identifier } of [plan.container, ...plan.slices]) {
    if (identifier === null) {
      continue;
    }

    if (identifiers.has(identifier)) {
      throw new Error(`Malformed slice draft ${path}: ${identifier} appears more than once.`);
    }

    identifiers.add(identifier);
  }
};

const rejectBadBlockers = (path: string, plan: Plan) => {
  const problem = blockerProblem(plan.slices.map((slice) => slice.blockedBy));

  if (problem !== undefined) {
    throw new Error(`Malformed slice draft ${path}: ${problem}`);
  }
};

const rejectBadReferences = (path: string, plan: Plan) => {
  const titles = new Set<string>();

  rejectRepeatedIdentifiers(path, plan);
  rejectBadBlockers(path, plan);

  for (const slice of plan.slices) {
    if (titles.has(slice.title)) {
      throw new Error(`Malformed slice draft ${path}: two slices use the title "${slice.title}".`);
    }

    titles.add(slice.title);
  }
};

export const readBody = async (directory: string, file: string): Promise<string> => {
  const body = await readOptionalText(join(directory, file));

  if (body === undefined) {
    throw new Error(`The slice draft names ${file}, but ${join(directory, file)} does not exist.`);
  }

  return body;
};

export const readPlan = async (directory: string): Promise<Plan | undefined> => {
  const path = join(directory, planFileName);

  const plan = await readVersionedRecord(path, {
    label: 'slice draft',
    version: currentVersion,
    schema: planSchema,
  });

  if (plan !== undefined) {
    rejectBadReferences(path, plan);
  }

  return plan;
};

export const readDraft = async (directory: string): Promise<Draft | undefined> => {
  const plan = await readPlan(directory);

  if (plan === undefined) {
    return undefined;
  }

  const containerBody = await readBody(directory, plan.container.file);

  const sliceBodies: string[] = [];

  for (const slice of plan.slices) {
    // oxlint-disable-next-line no-await-in-loop -- Reading in plan order names the first missing file.
    sliceBodies.push(await readBody(directory, slice.file));
  }

  return { plan, containerBody, sliceBodies };
};

export const writePlan = (directory: string, plan: Plan): Promise<void> =>
  writeRecord(join(directory, planFileName), plan);
