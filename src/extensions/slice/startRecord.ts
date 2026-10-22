import { join } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';

import { readVersionedRecord, writeRecord } from '../../record.js';
import { readBody } from './draft.js';

export interface StartDraft {
  start: Start;
  bodies: string[];
}

const startFileName = 'start.json';

const currentVersion = 1;

const identifierSchema = Type.String({ pattern: '^[A-Z][A-Z0-9]*-[0-9]+$' });

const startSchema = Type.Object(
  {
    version: Type.Literal(currentVersion),
    slice: identifierSchema,
    branch: Type.String({ minLength: 1 }),
    base: Type.String({ minLength: 1 }),
    tickets: Type.Array(
      Type.Object(
        {
          title: Type.String({ minLength: 1, pattern: '\\S' }),
          file: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*\\.md$' }),
          labels: Type.Array(Type.String({ minLength: 1 })),
          identifier: Type.Union([identifierSchema, Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type Start = Static<typeof startSchema>;

// Apply writes one Linear issue per ticket, so a repeated title, file, or identifier would write
// one issue twice.
const rejectRepeats = (path: string, start: Start) => {
  const fields = ['title', 'file', 'identifier'] as const;

  for (const field of fields) {
    const seen = new Set<string>();

    for (const ticket of start.tickets) {
      const value = ticket[field];

      if (value === null) {
        continue;
      }

      if (seen.has(value)) {
        throw new Error(`Malformed start record ${path}: two tickets use the ${field} "${value}".`);
      }

      seen.add(value);
    }
  }
};

// Reads the record and every body file it names. Undefined when the draft has no start.json.
export const readStartDraft = async (directory: string): Promise<StartDraft | undefined> => {
  const path = join(directory, startFileName);

  const start = await readVersionedRecord(path, {
    label: 'start record',
    version: currentVersion,
    schema: startSchema,
  });

  if (start === undefined) {
    return undefined;
  }

  rejectRepeats(path, start);

  const bodies: string[] = [];

  for (const ticket of start.tickets) {
    // oxlint-disable-next-line no-await-in-loop -- Reading in work order names the first missing file.
    bodies.push(await readBody(directory, ticket.file));
  }

  return { start, bodies };
};

export const writeStart = (directory: string, start: Start): Promise<void> =>
  writeRecord(join(directory, startFileName), start);
