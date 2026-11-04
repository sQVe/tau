import { join } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { errorMessage } from '../../errors.js';
import { readVersionedRecord, writeRecord } from '../../record.js';
import { decideViewerReply } from './reviewDecisions.js';
import type { ViewerReplyDecision, ViewerReplyState } from './reviewDecisions.js';

export interface ViewerFile {
  // Relative to the `.tau` directory, as the review holds it.
  path: string;
  stagedPath: string;
}

export interface ViewerComment {
  // Relative to the `.tau` directory, after the staged path is mapped back.
  path: string;
  startLine: number | null;
  endLine: number | null;
  type: string;
  content: string;
}

const requestFileName = 'request.json';
const commentsFileName = 'comments.json';
const requestVersion = 1;
const commentsVersion = 1;

const requestSchema = Type.Object(
  {
    version: Type.Literal(requestVersion),
    reviewId: Type.String({ minLength: 1 }),
    files: Type.Array(
      Type.Object(
        { path: Type.String({ minLength: 1 }), stagedPath: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type ViewerRequest = Static<typeof requestSchema>;

const viewerCommentSchema = Type.Object(
  {
    file: Type.String({ minLength: 1 }),
    startLine: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    endLine: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    type: Type.String(),
    content: Type.String(),
  },
  { additionalProperties: false },
);

const replySchema = Type.Union([
  Type.Object(
    {
      version: Type.Literal(commentsVersion),
      reviewId: Type.String({ minLength: 1 }),
      state: Type.Union([Type.Literal('open'), Type.Literal('submitted')]),
      comments: Type.Array(viewerCommentSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(commentsVersion),
      reviewId: Type.String({ minLength: 1 }),
      state: Type.Literal('error'),
      reason: Type.String({ minLength: 1 }),
      comments: Type.Array(viewerCommentSchema),
    },
    { additionalProperties: false },
  ),
]);

type ViewerReply = Static<typeof replySchema>;

export class ViewerProtocolRefusalError extends Error {
  override name = 'ViewerProtocolRefusalError';
}

export const writeRequest = async (
  recordDirectory: string,
  request: ViewerRequest,
): Promise<void> => {
  await writeRecord(join(recordDirectory, requestFileName), request);
};

const refusalOf = (
  decision: Exclude<ViewerReplyDecision, { kind: 'accepted' }>,
  path: string,
  reviewId: string,
): ViewerProtocolRefusalError => {
  if (decision.kind === 'viewer-error') {
    return new ViewerProtocolRefusalError(
      `draft_review refused the viewer reply in ${path}: the viewer reported an error: ${decision.reason}.`,
    );
  }

  if (decision.kind === 'foreign-review') {
    return new ViewerProtocolRefusalError(
      `draft_review refused the viewer reply in ${path}: it belongs to review ${decision.claimedReviewId}, not ${reviewId}.`,
    );
  }

  return new ViewerProtocolRefusalError(
    `draft_review refused the viewer reply in ${path}: ${decision.file} is not a file of this review.`,
  );
};

const stateOf = (reply: ViewerReply): ViewerReplyState => {
  if (reply.state === 'error') {
    return { kind: 'error', reason: reply.reason };
  }

  return reply.state === 'open' ? { kind: 'open' } : { kind: 'submitted' };
};

export const readViewerComments = async (
  recordDirectory: string,
  reviewId: string,
  files: readonly ViewerFile[],
): Promise<ViewerComment[] | undefined> => {
  const path = join(recordDirectory, commentsFileName);
  let reply: ViewerReply | undefined;

  try {
    reply = await readVersionedRecord(path, {
      label: 'viewer comments',
      version: commentsVersion,
      schema: replySchema,
    });
  } catch (error) {
    throw new ViewerProtocolRefusalError(errorMessage(error), { cause: error });
  }

  if (reply === undefined) {
    return undefined;
  }

  const decision = decideViewerReply({
    state: stateOf(reply),
    claimedReviewId: reply.reviewId,
    reviewId,
    files: reply.comments.map(({ file }) => file),
    stagedPaths: files.map(({ stagedPath }) => stagedPath),
  });

  if (decision.kind !== 'accepted') {
    throw refusalOf(decision, path, reviewId);
  }

  const pathByStaged = new Map(
    files.map(({ path: filePath, stagedPath }) => [stagedPath, filePath]),
  );

  return reply.comments.flatMap((comment) => {
    const commentPath = pathByStaged.get(comment.file);

    return commentPath === undefined
      ? []
      : [
          {
            path: commentPath,
            startLine: comment.startLine,
            endLine: comment.endLine,
            type: comment.type,
            content: comment.content,
          },
        ];
  });
};
