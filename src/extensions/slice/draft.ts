import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../../errors.js';
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

  const sliceBodies: string[] = [];

  for (const slice of plan.slices) {
    // oxlint-disable-next-line no-await-in-loop -- Reading in plan order names the first missing file.
    sliceBodies.push(await readBody(directory, slice.file));
  }

  return { plan, containerBody, sliceBodies };
};

const hasOtherHardLinks = async (path: string) => {
  const stats = await lstat(path);

  return stats.nlink > 1;
};

// A linked draft file could send the model's or the tool's writes outside the repository, and a
// body read through a hard link could send another file's contents to Linear.
export const rejectLinkedDraftFiles = async (directory: string): Promise<void> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const link = entries.find((entry) => entry.isSymbolicLink());

  if (link !== undefined) {
    throw new Error(`Refusing to write through a symlink: ${join(directory, link.name)}`);
  }

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(directory, entry.name));

  const hardLinked = await Promise.all(files.map((file) => hasOtherHardLinks(file)));
  const firstHardLinked = files.find((_, index) => hardLinked[index] === true);

  if (firstHardLinked !== undefined) {
    throw new Error(`Refusing a draft file with another hard link: ${firstHardLinked}`);
  }
};

const isSymlink = async (path: string) => {
  try {
    const stats = await lstat(path);

    return stats.isSymbolicLink();
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }

    throw error;
  }
};

// Writes a new file and renames it over plan.json, so a failed save keeps the saved identifiers.
// The rename replaces a link at plan.json instead of following it.
export const writePlan = async (directory: string, plan: Plan): Promise<void> => {
  const path = join(directory, planFileName);
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  const temporary = join(directory, `.${planFileName}.${randomUUID()}`);

  if (await isSymlink(path)) {
    throw new Error(`Refusing to write through a symlink: ${path}`);
  }

  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });

    throw error;
  }
};
