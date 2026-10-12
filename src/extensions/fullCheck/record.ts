import { randomUUID } from 'node:crypto';
import { access, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../../errors.js';
import type { CheckIdentity, SavedLog } from './reuseDecision.js';

export type RecordRead =
  | { status: 'valid'; record: CheckIdentity & { version: 1; fingerprint: string } }
  | { status: 'missing' }
  | { status: 'malformed' };

const checkRecordVersion = 1;

const checkRecordSchema = Type.Object(
  {
    version: Type.Literal(checkRecordVersion),
    head: Type.String({ minLength: 1 }),
    base: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    fingerprint: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

type CheckRecord = Static<typeof checkRecordSchema>;

export const recordPathFor = (logPath: string): string => logPath.replace(/\.log$/u, '.json');

const logPathFor = (recordPath: string): string => recordPath.replace(/\.json$/u, '.log');

export const readCheckRecord = async (recordPath: string): Promise<RecordRead> => {
  let text: string;

  try {
    text = await readFile(recordPath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return { status: 'missing' };
    }

    throw error;
  }

  try {
    const value: unknown = JSON.parse(text);

    return Value.Check(checkRecordSchema, value)
      ? { status: 'valid', record: value }
      : { status: 'malformed' };
  } catch {
    return { status: 'malformed' };
  }
};

// Writes next to the log through a rename, so a reader never sees half a record.
export const saveCheckRecord = async (logPath: string, identity: CheckIdentity): Promise<void> => {
  const { fingerprint } = identity;

  if (fingerprint === null) {
    throw new Error('A state with changes inside a submodule cannot be saved for reuse.');
  }

  const record: CheckRecord = { version: checkRecordVersion, ...identity, fingerprint };
  const recordPath = recordPathFor(logPath);
  const temporaryPath = `${recordPath}.${randomUUID()}.tmp`;

  await writeFile(temporaryPath, `${JSON.stringify(record, undefined, 2)}\n`);
  await rename(temporaryPath, recordPath);
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);

    return true;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }

    throw error;
  }
};

// Lists the logs of a checkout with their records, newest first.
export const listSavedLogs = async (checksDirectory: string): Promise<SavedLog[]> => {
  let names: string[];

  try {
    names = await readdir(checksDirectory);
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }

  const recordNames = names
    .filter((name) => name.endsWith('.json'))
    .toSorted()
    .toReversed();

  return Promise.all(
    recordNames.map(async (name) => {
      const logPath = logPathFor(join(checksDirectory, name));
      const read = await readCheckRecord(join(checksDirectory, name));

      return {
        logPath,
        record: read.status === 'valid' ? read.record : undefined,
        logExists: await exists(logPath),
      };
    }),
  );
};
