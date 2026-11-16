import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { errorMessage, isMissingFile } from '../errors.js';
import { parseVersionedRecord, readOptionalText } from '../record.js';
import { isRecord } from '../schema.js';
import {
  itemRecordSchema,
  itemRecordVersion,
  runRecordSchema,
  runRecordVersion,
  stepOutcomeSchemas,
  stepSchemas,
} from './records.js';
import type { ItemRead, ItemRecord, RecordRead, RunRead, RunRecord } from './records.js';

const outcomeSchemaByStatus = new Map<unknown, TSchema>(Object.entries(stepOutcomeSchemas));

const stepSchemaByStatus = new Map<unknown, TSchema>(Object.entries(stepSchemas));

export const runRecordPath = (runDirectory: string): string => join(runDirectory, 'run.json');

export const itemRecordPath = (runDirectory: string, item: string): string =>
  join(runDirectory, 'items', `${item}.json`);

const variantProblem = (
  value: unknown,
  path: string,
  schemas: ReadonlyMap<unknown, TSchema>,
): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const schema = schemas.get(value['status']);

  if (schema === undefined) {
    return undefined;
  }

  const [error] = Value.Errors(schema, value);

  return error === undefined ? undefined : `${path}${error.instancePath} ${error.message}`;
};

const artifactProblem = (value: unknown, path: string): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const artifactPath = value['path'];

  if (typeof artifactPath !== 'string') {
    return undefined;
  }

  const segments = artifactPath.split('/');

  const invalid =
    artifactPath.startsWith('/') ||
    artifactPath.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..');

  return invalid
    ? `${path} path must be relative and use / without empty, . or .. segments`
    : undefined;
};

const stepProblem = (value: unknown, index: number): string | undefined => {
  const path = `/steps/${index}`;
  const variant = variantProblem(value, path, stepSchemaByStatus);

  if (variant !== undefined) {
    return variant;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const number = value['number'];

  if (typeof number === 'number' && number !== index + 1) {
    return `${path} number is ${number}, expected ${index + 1}`;
  }

  const artifacts = value['artifacts'];

  if (!Array.isArray(artifacts)) {
    return undefined;
  }

  for (const [artifactIndex, artifact] of artifacts.entries()) {
    const problem = artifactProblem(artifact, `${path}/artifacts/${artifactIndex}`);

    if (problem !== undefined) {
      return problem;
    }
  }

  return undefined;
};

const canonicalTimestampProblem = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const startedAt = value['startedAt'];

  if (typeof startedAt !== 'string') {
    return undefined;
  }

  let canonical: string | undefined;

  try {
    canonical = new Date(startedAt).toISOString();
  } catch {
    canonical = undefined;
  }

  return canonical === startedAt ? undefined : `/startedAt is not a canonical timestamp`;
};

const duplicateItemProblem = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const items = value['items'];

  if (!Array.isArray(items)) {
    return undefined;
  }

  const seen = new Map<string, string>();

  for (const [index, item] of items.entries()) {
    const name = isRecord(item) ? item['item'] : undefined;

    if (typeof name !== 'string') {
      continue;
    }

    const folded = name.toLowerCase();
    const earlier = seen.get(folded);

    if (earlier !== undefined) {
      return `/items/${index} duplicates item ${earlier}`;
    }

    seen.set(folded, name);
  }

  return undefined;
};

const itemNameProblem = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const items = value['items'];

  if (!Array.isArray(items)) {
    return undefined;
  }

  for (const [index, item] of items.entries()) {
    const name = isRecord(item) ? item['item'] : undefined;

    if (typeof name !== 'string') {
      continue;
    }

    const segments = name.split('/');
    const earlierSegments = segments.slice(0, -1);

    const collides = earlierSegments.some((segment) => segment.toLowerCase().endsWith('.json'));

    if (collides) {
      return `/items/${index} item ${name} has a segment ending in .json, which collides with an item file path`;
    }
  }

  return undefined;
};

const runRecordProblem = (value: unknown): string | undefined =>
  canonicalTimestampProblem(value) ?? itemNameProblem(value) ?? duplicateItemProblem(value);

const itemRecordProblem = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const steps = value['steps'];

  if (Array.isArray(steps)) {
    for (const [index, step] of steps.entries()) {
      const problem = stepProblem(step, index);

      if (problem !== undefined) {
        return problem;
      }
    }
  }

  return variantProblem(value['endState'], '/endState', outcomeSchemaByStatus);
};

const readRecord = async <Schema extends TSchema>(
  path: string,
  label: string,
  version: number,
  schema: Schema,
  check: (value: unknown) => string | undefined,
): Promise<RecordRead<Static<Schema>>> => {
  let text: string | undefined;

  try {
    text = await readOptionalText(path);
  } catch (error) {
    return { status: 'malformed', problem: errorMessage(error) };
  }

  if (text === undefined) {
    return { status: 'missing' };
  }

  try {
    const record = parseVersionedRecord(path, text, { label, version, schema, check });

    return { status: 'valid', record };
  } catch (error) {
    return { status: 'malformed', problem: errorMessage(error) };
  }
};

export const readRunRecord = async (path: string): Promise<RecordRead<RunRecord>> =>
  readRecord(path, 'run record', runRecordVersion, runRecordSchema, runRecordProblem);

export const readItemRecord = async (path: string): Promise<RecordRead<ItemRecord>> =>
  readRecord(path, 'item record', itemRecordVersion, itemRecordSchema, itemRecordProblem);

const runDirectoryProblem = (record: RunRecord, run: string): string | undefined =>
  record.run === run ? undefined : `/run ${record.run} does not match the directory name ${run}`;

const registeredItemProblem = (
  record: ItemRecord,
  run: RunRecord,
  registered: RunRecord['items'][number],
): string | undefined => {
  if (record.run !== run.run) {
    return `/run is ${record.run}, but the run record is ${run.run}`;
  }

  if (record.item !== registered.item) {
    return `/item is ${record.item}, but the run registers ${registered.item}`;
  }

  return record.steps.length === registered.steps
    ? undefined
    : `/steps has ${record.steps.length} steps, but the run registers ${registered.steps}`;
};

const readRegisteredItem = async (
  directory: string,
  run: RunRecord,
  registered: RunRecord['items'][number],
): Promise<ItemRead> => {
  const path = itemRecordPath(directory, registered.item);
  const read = await readItemRecord(path);

  if (read.status !== 'valid') {
    return { item: registered.item, path, read };
  }

  const problem = registeredItemProblem(read.record, run, registered);

  if (problem === undefined) {
    return { item: registered.item, path, read };
  }

  return { item: registered.item, path, read: { status: 'malformed', problem } };
};

const listRunNames = async (verificationDirectory: string): Promise<string[]> => {
  try {
    const entries = await readdir(verificationDirectory, { withFileTypes: true });
    const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

    return names.toSorted();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

export const readRuns = async (verificationDirectory: string): Promise<RunRead[]> => {
  const names = await listRunNames(verificationDirectory);

  return Promise.all(
    names.map(async (run) => {
      const directory = join(verificationDirectory, run);
      const read = await readRunRecord(runRecordPath(directory));

      if (read.status !== 'valid') {
        return { run, directory, read, items: [] };
      }

      const problem = runDirectoryProblem(read.record, run);

      if (problem !== undefined) {
        return { run, directory, read: { status: 'malformed', problem }, items: [] };
      }

      const items = await Promise.all(
        read.record.items.map((registered) =>
          readRegisteredItem(directory, read.record, registered),
        ),
      );

      return { run, directory, read, items };
    }),
  );
};
