import { join } from 'node:path';

import type { Static, TProperties } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { errorMessage } from '../../errors.js';
import { parseRepository } from '../../github/github.js';
import type { Repository } from '../../github/github.js';
import { formatRepository } from '../../github/repositoryTargetDecisions.js';
import {
  parseVersionedRecord,
  readOptionalText,
  readVersionedRecord,
  savedVersion,
  writeRecord,
} from '../../record.js';
import { describeSchemaProblem } from '../../schema.js';

export interface PullRequestRecord {
  repository: Repository;
  pr: number;
}

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

const threadIdSchema = Type.String({ minLength: 1 });

// Each kind has one shape: a reply has a thread and text, a resolve has a thread and no text, and a
// PR comment has no thread and text. The saved fields sit beside the payload in every variant.
const writeVariants = <Saved extends TProperties>(saved: Saved) =>
  Type.Union([
    Type.Object(
      {
        kind: Type.Literal('reply'),
        thread: threadIdSchema,
        text: Type.String(),
        ...saved,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('resolve'),
        thread: threadIdSchema,
        text: Type.Null(),
        ...saved,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('comment'),
        thread: Type.Null(),
        text: Type.String(),
        ...saved,
      },
      { additionalProperties: false },
    ),
  ]);

const writePayloadSchema = writeVariants({});

const version1SavedFields = {
  url: Type.String(),
  commentId: Type.Union([Type.Integer(), Type.Null()]),
};

const postedVersion1WriteSchema = writeVariants(version1SavedFields);

const postedWriteSchema = writeVariants({
  ...version1SavedFields,
  state: Type.Union([Type.Literal('posted'), Type.Literal('uncertain')]),
  earlierCommentIds: Type.Array(Type.Integer()),
});

const postedSchema = Type.Object(
  { version: Type.Literal(postedVersion), writes: Type.Array(postedWriteSchema) },
  { additionalProperties: false },
);

const postedVersion1Schema = Type.Object(
  {
    version: Type.Literal(1),
    writes: Type.Array(postedVersion1WriteSchema),
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
export type WritePayload = Static<typeof writePayloadSchema>;
export type TargetedWrite = Static<typeof writePayloadSchema> & { url: string };
export type PostedWrite = Static<typeof postedWriteSchema>;
export type Posted = Static<typeof postedSchema>;

const repliesFileName = 'replies.json';
const postedFileName = 'posted.json';
const pullRequestFileName = 'pull-request.json';

const repliesExample = JSON.stringify({
  version: 1,
  threads: [{ id: '<thread id>', reply: '<text>', resolve: true }],
  comment: { body: '<text>', answers: ['<review or comment id>'] },
});

const readRequiredFile = async (path: string, missing: string) => {
  const text = await readOptionalText(path);

  if (text === undefined) {
    throw new Error(missing);
  }

  return text;
};

const checkReplies = (value: unknown) => {
  if (Value.Check(repliesSchema, value)) {
    return undefined;
  }

  return `${describeSchemaProblem(repliesSchema, value)}. Expected shape: ${repliesExample}, where reply and comment may be null`;
};

export const readReplies = async (directory: string): Promise<Replies> => {
  const path = join(directory, repliesFileName);
  const text = await readRequiredFile(path, `post needs ${path}. Nothing was posted.`);

  return parseVersionedRecord(path, text, {
    label: 'replies record',
    version: currentVersion,
    schema: repliesSchema,
    check: checkReplies,
  });
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

const isPostedVersion1 = (
  record: Static<typeof postedVersion1Schema> | Posted,
): record is Static<typeof postedVersion1Schema> => record.version === 1;

export const readPosted = async (directory: string): Promise<Posted> => {
  const path = join(directory, postedFileName);

  const posted = await readVersionedRecord(path, {
    label: 'posted record',
    version: postedVersion,
    schema: (value) => (savedVersion(value) === 1 ? postedVersion1Schema : postedSchema),
  });

  if (posted === undefined) {
    return { version: postedVersion, writes: [] };
  }

  return isPostedVersion1(posted) ? fromPostedVersion1(posted) : posted;
};

export const writePosted = (directory: string, writes: readonly PostedWrite[]): Promise<void> =>
  writeRecord(join(directory, postedFileName), { version: postedVersion, writes });

export const readPullRequestRecord = async (directory: string): Promise<PullRequestRecord> => {
  const path = join(directory, pullRequestFileName);

  const text = await readRequiredFile(
    path,
    `${directory} has no ${pullRequestFileName}. Pass the directory that read returned.`,
  );

  const record = parseVersionedRecord(path, text, {
    label: 'pull request record',
    version: currentVersion,
    schema: pullRequestRecordSchema,
  });

  try {
    return { repository: parseRepository(record.repository), pr: record.pr };
  } catch (error) {
    throw new Error(`Malformed pull request record ${path}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
};

export const writePullRequestRecord = (
  directory: string,
  record: PullRequestRecord,
): Promise<void> => {
  return writeRecord(join(directory, pullRequestFileName), {
    version: currentVersion,
    repository: formatRepository(record.repository),
    pr: record.pr,
  });
};
