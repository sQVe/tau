import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from './errors.js';
import { isRecord } from './isRecord.js';
import { describeSchemaProblem } from './schemaProblem.js';

export interface VersionedRecordOptions<Schema extends TSchema> {
  // Names the record in error messages, such as `capture record`.
  label: string;
  // The newest version this Tau reads.
  version: number;
  // One schema, or a function that picks the schema of the version the value claims.
  schema: Schema | ((value: unknown) => Schema);
  // Returns a problem the schema would report badly, such as one inside a union member.
  check?: (value: unknown) => string | undefined;
}

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const isNewerVersion = (value: unknown, version: number) => {
  const claimed = isRecord(value) ? value['version'] : undefined;

  return typeof claimed === 'number' && claimed > version;
};

export const parseVersionedRecord = <Schema extends TSchema>(
  path: string,
  text: string,
  options: VersionedRecordOptions<Schema>,
): Static<Schema> => {
  const { label, version, schema, check } = options;
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed ${label} ${path}: not JSON.`, { cause: error });
  }

  if (isNewerVersion(value, version)) {
    throw new Error(
      `${capitalize(label)} ${path} has a newer format than this Tau reads. Update Tau, then restart the session.`,
    );
  }

  const checkProblem = check?.(value);

  if (checkProblem !== undefined) {
    throw new Error(`Malformed ${label} ${path}: ${checkProblem}.`);
  }

  const chosen = typeof schema === 'function' ? schema(value) : schema;

  if (!Value.Check(chosen, value)) {
    throw new Error(`Malformed ${label} ${path}: ${describeSchemaProblem(chosen, value)}.`);
  }

  // SAFETY: Value.Check accepted the value against the chosen schema above.
  // oxlint-disable-next-line typescript/no-unsafe-return -- the generic schema type cannot narrow the checked value.
  return value;
};

export const readVersionedRecord = async <Schema extends TSchema>(
  path: string,
  options: VersionedRecordOptions<Schema>,
): Promise<Static<Schema> | undefined> => {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }

  // oxlint-disable-next-line typescript/no-unsafe-return -- parseVersionedRecord returns the generic schema type.
  return parseVersionedRecord(path, text, options);
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

// Writes a new file and renames it over the record, so a failed write keeps the old record or none.
// The rename replaces a link at the path instead of following it.
export const writeRecord = async (path: string, value: unknown): Promise<void> => {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}`);

  if (await isSymlink(path)) {
    throw new Error(`Refusing to write through a symlink: ${path}`);
  }

  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });

    throw error;
  }
};
