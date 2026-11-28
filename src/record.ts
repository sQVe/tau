import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from './errors.ts';
import { describeSchemaProblem, isRecord, newerRecordVersion } from './schema.ts';
import { isSymlink } from './tauDirectory.ts';

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

type FormatOptions = Pick<VersionedRecordOptions<TSchema>, 'label' | 'version'>;

export interface RecordFence {
  // Returns the reason to refuse, or undefined to publish.
  check: () => string | undefined;
  // Test seam: runs after the temporary write and before the check.
  beforePublish?: (() => Promise<void>) | undefined;
}

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const describeNewerFormat = (
  path: string,
  value: unknown,
  options: FormatOptions,
): string | undefined => {
  if (newerRecordVersion(value, options.version) === undefined) {
    return undefined;
  }

  return `${capitalize(options.label)} ${path} has a newer format than this Tau reads. Update Tau, then restart the session.`;
};

// Returns the notice for a record whose version is above `options.version`. Text that is not JSON
// is not newer, so parseVersionedRecord can refuse it as malformed.
export const newerFormatNotice = (
  path: string,
  text: string,
  options: FormatOptions,
): string | undefined => {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }

  return describeNewerFormat(path, value, options);
};

export const parseVersionedRecord = <Schema extends TSchema>(
  path: string,
  text: string,
  options: VersionedRecordOptions<Schema>,
): Static<Schema> => {
  const { label, schema, check } = options;
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed ${label} ${path}: not JSON.`, { cause: error });
  }

  const newerNotice = describeNewerFormat(path, value, options);

  if (newerNotice !== undefined) {
    throw new Error(newerNotice);
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

const temporaryPathFor = (path: string): string =>
  join(dirname(path), `.${basename(path)}.${randomUUID()}`);

const refuseSymlink = async (path: string): Promise<void> => {
  if (await isSymlink(path)) {
    throw new Error(`Refusing to write through a symlink: ${path}`);
  }
};

export const recordText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// Writes a new file and renames it over the record, so a failed write keeps the old record or none.
// The rename replaces a link at the path instead of following it.
export const writeRecord = async (path: string, value: unknown, mode?: number): Promise<void> => {
  const temporary = temporaryPathFor(path);

  await refuseSymlink(path);

  try {
    await writeFile(temporary, recordText(value), {
      flag: 'wx',
      ...(mode === undefined ? {} : { mode }),
    });

    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });

    throw error;
  }
};

// Like writeRecord, but publishes only while the fence allows it. Returns the refusal reason, or
// undefined when the record was published.
export const writeFencedRecord = async (
  path: string,
  value: unknown,
  fence: RecordFence,
): Promise<string | undefined> => {
  const temporary = temporaryPathFor(path);

  await refuseSymlink(path);

  try {
    await writeFile(temporary, recordText(value), { flag: 'wx' });
    await fence.beforePublish?.();

    // No await may sit between the check and the rename: the owner gives up the fact it checks
    // synchronously in this process, so the record publishes only while the fact still holds.
    const reason = fence.check();

    if (reason === undefined) {
      renameSync(temporary, path);

      return undefined;
    }

    await rm(temporary, { force: true });

    return reason;
  } catch (error) {
    await rm(temporary, { force: true });

    throw error;
  }
};

export const savedVersion = (value: unknown): unknown =>
  isRecord(value) ? value['version'] : undefined;

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

    const directory = openSync(dirname(path), 'r');

    try {
      linkSync(temporary, path);
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
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
