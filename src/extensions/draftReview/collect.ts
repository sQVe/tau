import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage, isMissingFile } from '../../errors.js';
import { loadCollectedRecord, saveCollectedRecord } from './collectedRecord.js';
import type { CollectedRecord } from './collectedRecord.js';
import { diffFiles } from './diff.js';
import { decideEdit, selectReviewedComments } from './reviewDecisions.js';
import type { SessionComment } from './reviewDecisions.js';
import { removeReview } from './stage.js';
import type { Review } from './stage.js';
import { deleteSessionComment, listSessionPaths, readSessionComments } from './tuicrSession.js';
import type { RunTuicr } from './tuicrSession.js';

interface ReviewedComment {
  path: string;
  startLine: number | null;
  endLine: number | null;
  type: string;
  content: string;
}

interface ReviewedEdit {
  path: string;
  diff: string;
  // A conflict means the real file changed during the review, so the edit was not written back.
  status: 'applied' | 'conflict';
}

export interface Collected {
  status: 'reviewed';
  comments: ReviewedComment[];
  edits: ReviewedEdit[];
}

interface SessionCommentRef {
  sessionPath: string;
  comment: SessionComment;
}

const readOptional = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

const readReviewedComments = async (
  run: RunTuicr,
  review: Review,
): Promise<SessionCommentRef[]> => {
  const sessionPaths = await listSessionPaths(run, review.stagingDirectory);

  const found = await Promise.all(
    sessionPaths.map(async (sessionPath) => {
      const comments = await readSessionComments(run, sessionPath);
      const kept = selectReviewedComments(comments, review.paths);

      return kept.map((comment) => ({ sessionPath, comment }));
    }),
  );

  return found.flat();
};

const readRequired = async (path: string): Promise<string> => (await readOptional(path)) ?? '';

const planEdit = async (review: Review, path: string) => {
  const originalPath = join(review.recordDirectory, 'originals', path);
  const original = await readRequired(originalPath);
  const staged = await readOptional(join(review.stagingDirectory, path));

  if (staged === undefined || staged === original) {
    return [];
  }

  const diff = await diffFiles(originalPath, join(review.stagingDirectory, path), path);

  return [{ path, diff, staged, status: 'pending' as const }];
};

const planCollect = async (run: RunTuicr, review: Review): Promise<CollectedRecord> => {
  const reviewed = await readReviewedComments(run, review);
  const planned = await Promise.all(review.paths.map((path) => planEdit(review, path)));

  const comments = reviewed.map(({ sessionPath, comment }) => ({
    sessionPath,
    id: comment.id,
    deleted: false,
    path: comment.path ?? '',
    startLine: comment.startLine,
    endLine: comment.endLine,
    type: comment.type,
    content: comment.content,
  }));

  return { comments, edits: planned.flat() };
};

// Deletes the comments not yet deleted, saving after each. A failure names the comments already
// deleted and the record to collect again.
const deleteComments = async (
  run: RunTuicr,
  review: Review,
  record: CollectedRecord,
): Promise<void> => {
  for (const comment of record.comments) {
    if (comment.deleted) {
      continue;
    }

    try {
      // oxlint-disable-next-line no-await-in-loop -- Deletes run in order and stop at the first failure.
      await deleteSessionComment(run, comment.sessionPath, comment.id);
    } catch (error) {
      const done = record.comments.filter(({ deleted }) => deleted).map(({ id }) => id);
      const doneText = done.length === 0 ? 'none' : done.join(', ');

      throw new Error(
        `Could not delete tuicr comment ${comment.id}; deleted before it: ${doneText}. Call collect again with directory ${review.recordDirectory} to finish. ${errorMessage(error)}`,
        { cause: error },
      );
    }

    comment.deleted = true;
    // oxlint-disable-next-line no-await-in-loop -- Save each delete before the next.
    await saveCollectedRecord(review.recordDirectory, record);
  }
};

// Reads the real file right before each write, so a change made during collect is never overwritten.
const writeBack = async (review: Review, record: CollectedRecord): Promise<void> => {
  for (const edit of record.edits) {
    if (edit.status !== 'pending') {
      continue;
    }

    const realPath = join(review.tauDirectory, edit.path);
    // oxlint-disable-next-line no-await-in-loop -- Each recheck must sit right before its write.
    const original = await readRequired(join(review.recordDirectory, 'originals', edit.path));
    // oxlint-disable-next-line no-await-in-loop -- Each recheck must sit right before its write.
    const current = await readOptional(realPath);
    const decision = decideEdit({ path: edit.path, original, staged: edit.staged, current });

    if (decision === 'apply') {
      // oxlint-disable-next-line no-await-in-loop -- Each write follows its own recheck.
      await writeFile(realPath, edit.staged);
    }

    edit.status = decision === 'apply' ? 'applied' : 'conflict';
    // oxlint-disable-next-line no-await-in-loop -- Save each outcome so a retry never re-decides it.
    await saveCollectedRecord(review.recordDirectory, record);
  }
};

export const collectReview = async (run: RunTuicr, review: Review): Promise<Collected> => {
  const saved = await loadCollectedRecord(review.recordDirectory);
  const record = saved ?? (await planCollect(run, review));

  if (saved === undefined) {
    await saveCollectedRecord(review.recordDirectory, record);
  }

  await deleteComments(run, review, record);
  await writeBack(review, record);
  await removeReview(review);

  const comments = record.comments.map((comment) => ({
    path: join(review.tauDirectory, comment.path),
    startLine: comment.startLine,
    endLine: comment.endLine,
    type: comment.type,
    content: comment.content,
  }));

  const edits = record.edits.map((edit) => ({
    path: join(review.tauDirectory, edit.path),
    diff: edit.diff,
    status: edit.status === 'applied' ? ('applied' as const) : ('conflict' as const),
  }));

  return { status: 'reviewed', comments, edits };
};
