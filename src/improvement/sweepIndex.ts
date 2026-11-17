import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { errorMessage } from '../errors.ts';
import {
  newerFormatNotice,
  parseVersionedRecord,
  readOptionalText,
  writeRecord,
} from '../record.ts';
import { stringEnum } from '../schema.ts';
import { transcriptStateSchema } from './transcript.ts';
import { assertWriteWithinTestRoot } from './writeGuard.ts';

export type SweepIndexRead =
  | { status: 'read'; index: SweepIndex }
  | { status: 'missing' }
  | { status: 'malformed'; reason: string }
  | { status: 'newer'; notice: string };

const sweepIndexVersion = 1;

const isoTime = Type.String({
  pattern: String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`,
});

const text = Type.String({ minLength: 1 });

const count = Type.Integer({ minimum: 0 });

const resolvedTranscriptSchema = Type.Object(
  {
    status: Type.Literal('resolved'),
    cwd: text,
    projectRoot: text,
    cursor: count,
    state: transcriptStateSchema,
  },
  { additionalProperties: false },
);

const unresolvedTranscriptSchema = Type.Object(
  {
    status: Type.Literal('unresolved'),
    cwd: Type.Union([text, Type.Null()]),
    reason: text,
  },
  { additionalProperties: false },
);

const transcriptEntrySchema = Type.Union([resolvedTranscriptSchema, unresolvedTranscriptSchema]);

const mergedReadSchema = Type.Union([
  Type.Object(
    { status: Type.Literal('read'), at: isoTime, count },
    { additionalProperties: false },
  ),
  Type.Object(
    { status: Type.Literal('unknown'), at: isoTime, reason: text },
    { additionalProperties: false },
  ),
  Type.Object({ status: Type.Literal('notRead') }, { additionalProperties: false }),
]);

const projectEntrySchema = Type.Object(
  {
    repository: Type.Union([text, Type.Null()]),
    merged: mergedReadSchema,
  },
  { additionalProperties: false },
);

const lastSweepSchema = Type.Union([
  Type.Null(),
  Type.Object(
    {
      startedAt: isoTime,
      outcome: stringEnum(['caughtUp', 'budget', 'failed']),
      reason: Type.Optional(text),
    },
    { additionalProperties: false },
  ),
]);

const sweepIndexSchema = Type.Object(
  {
    version: Type.Literal(sweepIndexVersion),
    transcripts: Type.Record(Type.String(), transcriptEntrySchema),
    projects: Type.Record(Type.String(), projectEntrySchema),
    lastSweep: lastSweepSchema,
  },
  { additionalProperties: false },
);

export type SweepIndex = Static<typeof sweepIndexSchema>;

const sweepIndexOptions = {
  label: 'sweep index',
  version: sweepIndexVersion,
  schema: sweepIndexSchema,
};

const sweepIndexDirectory = (agentDirectory: string) => join(agentDirectory, 'tau', 'improvement');

export const sweepIndexPath = (agentDirectory: string): string =>
  join(sweepIndexDirectory(agentDirectory), 'index.json');

export const readSweepIndex = async (agentDirectory: string): Promise<SweepIndexRead> => {
  const path = sweepIndexPath(agentDirectory);
  const source = await readOptionalText(path);

  if (source === undefined) {
    return { status: 'missing' };
  }

  const notice = newerFormatNotice(path, source, sweepIndexOptions);

  if (notice !== undefined) {
    return { status: 'newer', notice };
  }

  try {
    return { status: 'read', index: parseVersionedRecord(path, source, sweepIndexOptions) };
  } catch (error) {
    return { status: 'malformed', reason: errorMessage(error) };
  }
};

export const writeSweepIndex = async (agentDirectory: string, index: SweepIndex): Promise<void> => {
  const directory = sweepIndexDirectory(agentDirectory);

  assertWriteWithinTestRoot(sweepIndexPath(agentDirectory));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeRecord(sweepIndexPath(agentDirectory), index);
};
