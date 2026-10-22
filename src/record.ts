import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from './errors.js';
import { describeSchemaProblem, isRecord } from './schema.js';

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

  // oxlint-disable-next-line typescript/no-unsafe-return -- the generic schema type cannot narrow the checked value.
  return value;
};

export const readOptionalText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

export const readVersionedRecord = async <Schema extends TSchema>(
  path: string,
  options: VersionedRecordOptions<Schema>,
): Promise<Static<Schema> | undefined> => {
  const text = await readOptionalText(path);

  if (text === undefined) {
    return undefined;
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

export const savedVersion = (value: unknown): unknown =>
  isRecord(value) ? value['version'] : undefined;

const fsyncPath = (path: string, flags: string) => {
  const descriptor = openSync(path, flags);

  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

// Publishes a complete file without replacing an existing record. The temporary name starts with
// `.receipt-`, which readers of unpublished folders match.
export const publishTextSync = (path: string, text: string, options: { mode: number }): void => {
  const temporary = join(dirname(path), `.receipt-${randomUUID()}`);
  const descriptor = openSync(temporary, 'wx', options.mode);

  try {
    try {
      writeFileSync(descriptor, text);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    linkSync(temporary, path);
    fsyncPath(dirname(path), 'r');
  } finally {
    unlinkSync(temporary);
  }
};

// Returns undefined when the file holds more than `byteLimit` bytes. Read errors, a missing file
// included, are thrown.
export const readTextWithinSync = (path: string, byteLimit: number): string | undefined => {
  const descriptor = openSync(path, 'r');

  try {
    const buffer = Buffer.alloc(byteLimit + 1);
    let bytesRead = 0;

    while (bytesRead < buffer.length) {
      const read = readSync(descriptor, buffer, {
        offset: bytesRead,
        length: buffer.length - bytesRead,
        position: bytesRead,
      });

      if (read === 0) {
        break;
      }

      bytesRead += read;
    }

    return bytesRead > byteLimit ? undefined : buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
};
