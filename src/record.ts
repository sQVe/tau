import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { errorMessage, hasErrorCode, isMissingFile } from './errors.js';
import { describeSchemaProblem, isRecord } from './schema.js';
import { climbsOut, isSymlink } from './tauDirectory.js';

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

export interface ContainedTextRequest {
  directory: string;
  path: string;
  byteLimit: number;
  label: string;
}

// `exists`: another file holds the path, and nothing was published. `notLinked`: a step before the
// link failed, and nothing was published. `linked`: the file was published, then a later step failed.
export type PublishFailure = 'exists' | 'notLinked' | 'linked';

type PublishStep = 'write' | 'link' | 'linked';

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

export const serializeRecord = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// Writes a new file and renames it over the record, so a failed write keeps the old record or none.
// The rename replaces a link at the path instead of following it.
export const writeRecord = async (path: string, value: unknown): Promise<void> => {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}`);

  if (await isSymlink(path)) {
    throw new Error(`Refusing to write through a symlink: ${path}`);
  }

  try {
    await writeFile(temporary, serializeRecord(value), { flag: 'wx' });
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

export class PublishError extends Error {
  readonly failure: PublishFailure;

  constructor(failure: PublishFailure, cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = 'PublishError';
    this.failure = failure;
  }
}

const publishFailure = (step: PublishStep, error: unknown): PublishFailure => {
  if (step === 'linked') {
    return 'linked';
  }

  const isExisting = step === 'link' && hasErrorCode(error, 'EEXIST');

  return isExisting ? 'exists' : 'notLinked';
};

const writeSynced = (descriptor: number, text: string): void => {
  try {
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

// Publishes a complete file without replacing an existing record, and throws a PublishError that
// says whether the file was published. The temporary name starts with `.receipt-`, which readers of
// unpublished folders match.
export const publishTextSync = (path: string, text: string, options: { mode: number }): void => {
  const temporary = join(dirname(path), `.receipt-${randomUUID()}`);
  let step: PublishStep = 'write';

  try {
    const descriptor = openSync(temporary, 'wx', options.mode);

    try {
      writeSynced(descriptor, text);
      step = 'link';
      linkSync(temporary, path);
      step = 'linked';
      fsyncPath(dirname(path), 'r');
    } finally {
      unlinkSync(temporary);
    }
  } catch (error) {
    throw new PublishError(publishFailure(step, error), error);
  }
};

const firstSymlinkComponent = async (
  directory: string,
  path: string,
): Promise<string | undefined> => {
  const relativeParent = relative(directory, dirname(path));
  const names = relativeParent === '' ? [] : relativeParent.split(sep);
  const components = [directory];
  let current = directory;

  for (const name of names) {
    current = join(current, name);
    components.push(current);
  }

  components.push(path);

  const linked = await Promise.all(components.map((component) => isSymlink(component)));

  return components.find((_, index) => linked[index] === true);
};

export const readContainedText = async (request: ContainedTextRequest): Promise<string> => {
  const { directory, path, byteLimit, label } = request;

  if (resolve(path) !== path || resolve(directory) !== directory) {
    throw new Error(`Refusing to read ${label} from a path that is not canonical: ${path}`);
  }

  const realDirectory = await realpath(directory).catch((error: unknown) => {
    if (isMissingFile(error)) {
      throw new Error(`${label} directory does not exist: ${directory}`, { cause: error });
    }

    throw error;
  });

  if (realDirectory !== directory) {
    throw new Error(`Refusing to read ${label} from a symlinked approved directory: ${directory}`);
  }

  if (climbsOut(relative(directory, path))) {
    throw new Error(`${label} is outside the allowed directory: ${path}`);
  }

  const symlink = await firstSymlinkComponent(directory, path);

  if (symlink !== undefined) {
    throw new Error(`Refusing to read ${label} through a symlink: ${symlink}`);
  }

  const realFile = await realpath(path).catch((error: unknown) => {
    if (isMissingFile(error)) {
      throw new Error(`${label} does not exist: ${path}`, { cause: error });
    }

    throw error;
  });

  if (climbsOut(relative(realDirectory, realFile))) {
    throw new Error(`${label} is outside the allowed directory: ${path}`);
  }

  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (hasErrorCode(error, 'ELOOP')) {
      throw new Error(`Refusing to read ${label} through a symlink: ${path}`, { cause: error });
    }

    throw error;
  });

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error(`${label} is not a regular file: ${path}`);
    }

    if (stats.size === 0) {
      throw new Error(`${label} is empty: ${path}`);
    }

    const buffer = Buffer.alloc(byteLimit + 1);
    let bytesRead = 0;

    while (bytesRead < buffer.length) {
      const read = readSync(handle.fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);

      if (read === 0) {
        break;
      }

      bytesRead += read;
    }

    if (bytesRead > byteLimit) {
      throw new Error(`${label} is larger than ${byteLimit} bytes: ${path}`);
    }

    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
};
