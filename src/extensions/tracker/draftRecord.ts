import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../../errors.js';
import { readVersionedRecord, writeRecord } from '../../record.js';
import { describeSchemaProblem } from '../../schema.js';

export interface DraftLookup {
  name: string;
  draft: DraftRecord | null;
  malformed: string[];
}

const draftFileName = 'draft.json';

const currentVersion = 2;

const identifierSchema = Type.Union([
  Type.String({ pattern: '^[A-Z][A-Z0-9]*-[0-9]+$' }),
  Type.Null(),
]);

const commentIdSchema = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);

const previousDraftSchema = Type.Object(
  {
    version: Type.Literal(1),
    identifier: identifierSchema,
    reviewCommentId: commentIdSchema,
  },
  { additionalProperties: false },
);

const draftSchema = Type.Object(
  {
    version: Type.Literal(currentVersion),
    identifier: identifierSchema,
    reviewCommentId: commentIdSchema,
    qualityCommentId: commentIdSchema,
  },
  { additionalProperties: false },
);

export type DraftRecord = Static<typeof draftSchema>;

const chooseSchema = (value: unknown) =>
  Value.Check(previousDraftSchema, value) ? previousDraftSchema : draftSchema;

export const readDraftRecord = async (directory: string): Promise<DraftRecord | null> => {
  const path = join(directory, draftFileName);

  const saved = await readVersionedRecord(path, {
    label: 'ticket draft',
    version: currentVersion,
    schema: chooseSchema,
  });

  if (saved === undefined) {
    return null;
  }

  if (saved.version === 1) {
    return { ...saved, version: currentVersion, qualityCommentId: null };
  }

  return saved;
};

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

const readSaved = (directory: string) =>
  readDraftRecord(directory).then(
    (draft) => ({ directory, draft, error: undefined }),
    (error: unknown) => ({ directory, draft: null, error: toError(error) }),
  );

const listDirectories = async (tickets: string) => {
  try {
    const entries = await readdir(tickets, { withFileTypes: true });

    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(tickets, entry.name));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

const rejectOtherIdentifier = (
  entry: { directory: string; draft: DraftRecord | null },
  id: string,
) => {
  const identifier = entry.draft?.identifier ?? null;

  if (identifier === null || identifier.toLowerCase() === id) {
    return;
  }

  const path = join(entry.directory, draftFileName);

  throw new Error(`The ticket draft ${path} records ${identifier}, not ${id}.`);
};

// Picks the directory whose draft.json records the identifier, or else the directory named id. An
// unreadable draft.json stops prepare only in the directory it returns.
export const findDraftFor = async (root: string, id: string): Promise<DraftLookup> => {
  const tickets = join(root, '.tau', 'tickets');
  const directories = await listDirectories(tickets);
  const saved = await Promise.all(directories.map((directory) => readSaved(directory)));
  const recorded = saved.filter((entry) => entry.draft?.identifier?.toLowerCase() === id);

  if (recorded.length > 1) {
    const names = recorded.map((entry) => entry.directory).join(' and ');

    throw new Error(`Two ticket drafts record ${id}: ${names}.`);
  }

  const selected = recorded[0] ?? saved.find((entry) => basename(entry.directory) === id);

  if (selected?.error !== undefined) {
    throw selected.error;
  }

  if (selected !== undefined) {
    rejectOtherIdentifier(selected, id);
  }

  const malformed = saved
    .filter((entry) => entry.error !== undefined)
    .map((entry) => join(entry.directory, draftFileName));

  return {
    name: selected === undefined ? id : basename(selected.directory),
    draft: selected?.draft ?? null,
    malformed,
  };
};

const fieldSchemas = {
  identifier: identifierSchema,
  reviewCommentId: commentIdSchema,
  qualityCommentId: commentIdSchema,
};

type DraftField = keyof typeof fieldSchemas;

const isDraftField = (field: string): field is DraftField => Object.hasOwn(fieldSchemas, field);

export const checkDraftField = (field: string, value: unknown): DraftField => {
  if (!isDraftField(field)) {
    throw new Error(
      `Invalid field ${JSON.stringify(field)}: use identifier, reviewCommentId, or qualityCommentId.`,
    );
  }

  const schema = fieldSchemas[field];

  if (typeof value !== 'string' || !Value.Check(schema, value)) {
    throw new Error(
      `Invalid value ${JSON.stringify(value)} for ${field}: ${describeSchemaProblem(schema, value)}.`,
    );
  }

  return field;
};

// Sets one field of the directory's draft.json and keeps the others. A missing record starts with
// every field null. It writes nothing when the existing record or the value is invalid.
export const writeDraftField = async (
  directory: string,
  field: string,
  value: unknown,
): Promise<DraftRecord> => {
  checkDraftField(field, value);

  const existing = await readDraftRecord(directory);

  const base: DraftRecord = existing ?? {
    version: currentVersion,
    identifier: null,
    reviewCommentId: null,
    qualityCommentId: null,
  };

  const written: DraftRecord = { ...base, [field]: value };
  const path = join(directory, draftFileName);

  await writeRecord(path, written);

  return written;
};
