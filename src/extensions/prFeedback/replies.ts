import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Static, TSchema } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { errorMessage, isMissingFile } from '../../errors.js';
import { parseRepository } from '../../github.js';
import type { Repository } from '../../github.js';
import { describeSchemaProblem } from '../../schemaProblem.js';
import { repositoryName } from './checkEvidence.js';

export interface PullRequestRecord {
  repository: Repository;
  pr: number;
}

// TypeScript accepts an assertion arrow function only through a declared type.
type CheckRecord = <Schema extends TSchema>(
  path: string,
  schema: Schema,
  value: unknown,
) => asserts value is Static<Schema>;

const currentVersion = 1;

const textSchema = Type.String({ minLength: 1, pattern: '\\S' });

const repliesSchema = Type.Object(
  {
    version: Type.Literal(currentVersion),
    threads: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          reply: Type.Union([textSchema, Type.Null()]),
          resolve: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    comment: Type.Union([
      Type.Object(
        { body: textSchema, answers: Type.Array(Type.String({ minLength: 1 })) },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

const postedVersion = 2;

const postedWriteFields = {
  kind: Type.Union([Type.Literal('reply'), Type.Literal('resolve'), Type.Literal('comment')]),
  thread: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  url: Type.String(),
  text: Type.Union([Type.String(), Type.Null()]),
  commentId: Type.Union([Type.Integer(), Type.Null()]),
};

const postedWriteSchema = Type.Object(
  {
    ...postedWriteFields,
    state: Type.Union([Type.Literal('posted'), Type.Literal('uncertain')]),
    earlierCommentIds: Type.Array(Type.Integer()),
  },
  { additionalProperties: false },
);

const postedSchema = Type.Object(
  { version: Type.Literal(postedVersion), writes: Type.Array(postedWriteSchema) },
  { additionalProperties: false },
);

const postedVersion1Schema = Type.Object(
  {
    version: Type.Literal(1),
    writes: Type.Array(Type.Object(postedWriteFields, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

const pullRequestRecordSchema = Type.Object(
  {
    version: Type.Literal(currentVersion),
    repository: Type.String(),
    pr: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export type Replies = Static<typeof repliesSchema>;
export type PostedWrite = Static<typeof postedWriteSchema>;
export type Posted = Static<typeof postedSchema>;

const repliesFileName = 'replies.json';
const postedFileName = 'posted.json';
const pullRequestFileName = 'pull-request.json';

const savedVersion = (value: unknown) =>
  typeof value === 'object' && value !== null && 'version' in value ? value.version : undefined;

const isNewerVersion = (value: unknown, current: number) => {
  const version = savedVersion(value);

  return typeof version === 'number' && version > current;
};

const parseRecordJson = (path: string, text: string, current = currentVersion): unknown => {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed ${path}: not JSON.`, { cause: error });
  }

  if (isNewerVersion(value, current)) {
    throw new Error(
      `${path} has a newer format than this Tau reads. Update Tau, then restart the session.`,
    );
  }

  return value;
};

const checkRecord: CheckRecord = (path, schema, value) => {
  if (!Value.Check(schema, value)) {
    throw new Error(`Malformed ${path}: ${describeSchemaProblem(schema, value)}.`);
  }
};

const readOptionalFile = async (path: string) => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

const readRequiredFile = async (path: string, missing: string) => {
  const text = await readOptionalFile(path);

  if (text === undefined) {
    throw new Error(missing);
  }

  return text;
};

// Writes a new file and renames it over the record, so a failed save keeps the saved record.
const writeRecord = async (path: string, record: unknown) => {
  const temporary = `${path}.${randomUUID()}`;

  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
};

export const readReplies = async (directory: string): Promise<Replies> => {
  const path = join(directory, repliesFileName);
  const text = await readRequiredFile(path, `post needs ${path}. Nothing was posted.`);
  const replies = parseRecordJson(path, text);

  checkRecord(path, repliesSchema, replies);

  return replies;
};

// Version 1 saved only writes that GitHub took.
const fromPostedVersion1 = (record: Static<typeof postedVersion1Schema>): Posted => ({
  version: postedVersion,
  writes: record.writes.map((write) => ({
    ...write,
    state: 'posted' as const,
    earlierCommentIds: [],
  })),
});

export const readPosted = async (directory: string): Promise<Posted> => {
  const path = join(directory, postedFileName);
  const text = await readOptionalFile(path);

  if (text === undefined) {
    return { version: postedVersion, writes: [] };
  }

  const posted = parseRecordJson(path, text, postedVersion);

  if (savedVersion(posted) === 1) {
    checkRecord(path, postedVersion1Schema, posted);

    return fromPostedVersion1(posted);
  }

  checkRecord(path, postedSchema, posted);

  return posted;
};

export const writePosted = (directory: string, writes: readonly PostedWrite[]): Promise<void> =>
  writeRecord(join(directory, postedFileName), { version: postedVersion, writes });

export const readPullRequestRecord = async (directory: string): Promise<PullRequestRecord> => {
  const path = join(directory, pullRequestFileName);

  const text = await readRequiredFile(
    path,
    `${directory} has no ${pullRequestFileName}. Pass the directory that read returned.`,
  );

  const record = parseRecordJson(path, text);

  checkRecord(path, pullRequestRecordSchema, record);

  try {
    return { repository: parseRepository(record.repository), pr: record.pr };
  } catch (error) {
    throw new Error(`Malformed ${path}: ${errorMessage(error)}`, { cause: error });
  }
};

export const writePullRequestRecord = (
  directory: string,
  record: PullRequestRecord,
): Promise<void> => {
  return writeRecord(join(directory, pullRequestFileName), {
    version: currentVersion,
    repository: repositoryName(record.repository),
    pr: record.pr,
  });
};
