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

const currentVersion = 3;

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

const versionTwoSchema = Type.Object(
  {
    version: Type.Literal(2),
    identifier: identifierSchema,
    reviewCommentId: commentIdSchema,
    qualityCommentId: commentIdSchema,
  },
  { additionalProperties: false },
);

const draftSchema = Type.Object(
  {
    version: Type.Literal(currentVersion),
    identifier: identifierSchema,
    comments: Type.Record(Type.String(), Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type DraftRecord = Static<typeof draftSchema>;

const chooseSchema = (value: unknown) => {
  if (Value.Check(previousDraftSchema, value)) {
    return previousDraftSchema;
  }

  return Value.Check(versionTwoSchema, value) ? versionTwoSchema : draftSchema;
};

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

  if (saved.version === currentVersion) {
    return saved;
  }

  const comments: Record<string, string> = {};

  const directoryIdentifier = basename(directory).toUpperCase();
  const headingIdentifier = saved.identifier ?? directoryIdentifier;

  if (/^[A-Z][A-Z0-9]*-[0-9]+$/.test(headingIdentifier)) {
    if (saved.reviewCommentId !== null) {
      comments[`# Code review: ${headingIdentifier}`] = saved.reviewCommentId;
    }

    if (saved.version === 2 && saved.qualityCommentId !== null) {
      comments[`# Code quality: ${headingIdentifier}`] = saved.qualityCommentId;
    }
  }

  return { version: currentVersion, identifier: saved.identifier, comments };
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

export const writeDraftRecord = async (directory: string, draft: DraftRecord): Promise<void> => {
  if (!Value.Check(draftSchema, draft)) {
    throw new Error(`Invalid ticket draft: ${describeSchemaProblem(draftSchema, draft)}.`);
  }

  await readDraftRecord(directory);
  await writeRecord(join(directory, draftFileName), draft);
};
