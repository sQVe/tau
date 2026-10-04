import { constants, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { hasErrorCode, isMissingFile } from '../../errors.js';

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

const schemaProblem = (value: unknown) => {
  const [error] = Value.Errors(planSchema, value);

  return error === undefined ? 'unknown problem' : `${error.instancePath || '/'} ${error.message}`;
};

const savedVersion = (value: unknown) =>
  typeof value === 'object' && value !== null && 'version' in value ? value.version : undefined;

const isNewerVersion = (value: unknown) => {
  const version = savedVersion(value);

  return typeof version === 'number' && version > currentVersion;
};

const rejectBadReferences = (path: string, plan: Plan) => {
  const titles = new Set<string>();

  for (const [index, slice] of plan.slices.entries()) {
    const number = index + 1;

    const unknownBlocker = slice.blockedBy.find(
      (blocker) => blocker > plan.slices.length || blocker === number,
    );

    if (unknownBlocker !== undefined) {
      throw new Error(
        `Malformed slice draft ${path}: slice ${number} is blocked by ${unknownBlocker}, which is not another slice in the plan.`,
      );
    }

    if (titles.has(slice.title)) {
      throw new Error(`Malformed slice draft ${path}: two slices use the title "${slice.title}".`);
    }

    titles.add(slice.title);
  }
};

const parsePlan = (path: string, text: string): Plan => {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed slice draft ${path}: not JSON.`, { cause: error });
  }

  if (isNewerVersion(value)) {
    throw new Error(
      `Slice draft ${path} has a newer format than this Tau reads. Update Tau, then restart the session.`,
    );
  }

  if (!Value.Check(planSchema, value)) {
    throw new Error(`Malformed slice draft ${path}: ${schemaProblem(value)}.`);
  }

  rejectBadReferences(path, value);

  return value;
};

const readOptionalFile = async (path: string) => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

const readBody = async (directory: string, file: string) => {
  const body = await readOptionalFile(join(directory, file));

  if (body === undefined) {
    throw new Error(`The slice draft names ${file}, but ${join(directory, file)} does not exist.`);
  }

  return body;
};

export const readPlan = async (directory: string): Promise<Plan | undefined> => {
  const path = join(directory, planFileName);
  const text = await readOptionalFile(path);

  return text === undefined ? undefined : parsePlan(path, text);
};

export const readDraft = async (directory: string): Promise<Draft | undefined> => {
  const plan = await readPlan(directory);

  if (plan === undefined) {
    return undefined;
  }

  const containerBody = await readBody(directory, plan.container.file);

  const sliceBodies = await Promise.all(
    plan.slices.map((slice) => readBody(directory, slice.file)),
  );

  return { plan, containerBody, sliceBodies };
};

// A linked draft file could send the model's or the tool's writes outside the repository.
export const rejectLinkedDraftFiles = async (directory: string): Promise<void> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const link = entries.find((entry) => entry.isSymbolicLink());

  if (link !== undefined) {
    throw new Error(`Refusing to write through a symlink: ${join(directory, link.name)}`);
  }
};

const openPlanForWrite = async (path: string) => {
  try {
    return await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (hasErrorCode(error, 'ELOOP')) {
      throw new Error(`Refusing to write through a symlink: ${path}`, { cause: error });
    }

    throw error;
  }
};

export const writePlan = async (directory: string, plan: Plan): Promise<void> => {
  const file = await openPlanForWrite(join(directory, planFileName));

  try {
    await file.writeFile(`${JSON.stringify(plan, null, 2)}\n`);
  } finally {
    await file.close();
  }
};
