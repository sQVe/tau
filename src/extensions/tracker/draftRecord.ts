import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../../errors.js';
import { describeSchemaProblem } from '../../schemaProblem.js';

export interface DraftLookup {
  name: string;
  draft: DraftRecord | null;
  malformed: string[];
}

const draftFileName = 'draft.json';

const currentVersion = 1;

const draftSchema = Type.Object(
  {
    version: Type.Literal(currentVersion),
    identifier: Type.Union([Type.String({ pattern: '^[A-Z][A-Z0-9]*-[0-9]+$' }), Type.Null()]),
    reviewCommentId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export type DraftRecord = Static<typeof draftSchema>;

const isNewerVersion = (value: unknown) => {
  const version =
    typeof value === 'object' && value !== null && 'version' in value ? value.version : undefined;

  return typeof version === 'number' && version > currentVersion;
};

const parseDraftRecord = (path: string, text: string): DraftRecord => {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed ticket draft ${path}: not JSON.`, { cause: error });
  }

  if (isNewerVersion(value)) {
    throw new Error(
      `Ticket draft ${path} has a newer format than this Tau reads. Update Tau, then restart the session.`,
    );
  }

  if (!Value.Check(draftSchema, value)) {
    throw new Error(
      `Malformed ticket draft ${path}: ${describeSchemaProblem(draftSchema, value)}.`,
    );
  }

  return value;
};

export const readDraftRecord = async (directory: string): Promise<DraftRecord | null> => {
  const path = join(directory, draftFileName);
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }

    throw error;
  }

  return parseDraftRecord(path, text);
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
