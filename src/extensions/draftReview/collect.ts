import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage, isMissingFile } from '../../errors.js';
import { loadCollectedRecord, saveCollectedRecord } from './collectedRecord.js';
import type { CollectedRecord } from './collectedRecord.js';
import {
  DestinationRefusalError,
  requireWritableDestination,
  writeDestination,
} from './destination.js';
import { diffFiles } from './diff.js';
import { decideEdit, selectReviewedComments } from './reviewDecisions.js';
import type { SessionComment } from './reviewDecisions.js';
import { removeReview, stagedPathOf } from './stage.js';
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

// tuicr names each file by its staged path; collect names it by its `.tau` path.
const pathOfStaged = (review: Review, stagedPath: string | null): string =>
  review.paths[review.stagedPaths.indexOf(stagedPath ?? '')] ?? '';

const readReviewedComments = async (
  run: RunTuicr,
  review: Review,
): Promise<SessionCommentRef[]> => {
  const sessionPaths = await listSessionPaths(run, review.stagingDirectory);

  const found = await Promise.all(
    sessionPaths.map(async (sessionPath) => {
      const comments = await readSessionComments(run, sessionPath);
      const kept = selectReviewedComments(comments, review.stagedPaths);

      return kept.map((comment) => ({
        sessionPath,
        comment: { ...comment, path: pathOfStaged(review, comment.path) },
      }));
    }),
  );

  return found.flat();
};

const originalPathOf = (review: Review, path: string) =>
  join(review.recordDirectory, 'originals', path);

class CollectRefusalError extends Error {
  override name = 'CollectRefusalError';
}

const readRequired = async (review: Review, path: string): Promise<string> => {
  const original = await readOptional(originalPathOf(review, path));

  if (original === undefined) {
    throw new CollectRefusalError(
      `draft_review cannot collect ${path}: its saved original is missing from ${review.recordDirectory}.`,
    );
  }

  return original;
};

const isRefusal = (error: unknown) =>
  error instanceof CollectRefusalError || error instanceof DestinationRefusalError;

// Says what collect already changed, from the record of an earlier or the current try.
const progressOf = (record: CollectedRecord | undefined): string => {
  const deleted = (record?.comments ?? []).filter(({ deleted: done }) => done);
  const applied = (record?.edits ?? []).filter(({ status }) => status === 'applied');

  if (deleted.length === 0 && applied.length === 0) {
    return 'Nothing was deleted or written.';
  }

  const deletedText = deleted.map(({ id }) => id).join(', ') || 'none';
  const appliedText = applied.map(({ path }) => path).join(', ') || 'none';

  return `Deleted tuicr comments: ${deletedText}. Written files: ${appliedText}.`;
};

const refusalWithProgress = (error: unknown, record: CollectedRecord | undefined): unknown =>
  isRefusal(error)
    ? new Error(`${errorMessage(error)} The review is kept. ${progressOf(record)}`, {
        cause: error,
      })
    : error;

const planEdit = async (review: Review, path: string, original: string) => {
  const originalPath = originalPathOf(review, path);
  const stagedPath = join(review.stagingDirectory, stagedPathOf(review, path));
  const staged = await readOptional(stagedPath);

  if (staged === undefined || staged === original) {
    return [];
  }

  const diff = await diffFiles(originalPath, stagedPath, path);

  return [{ path, diff, staged, status: 'pending' as const }];
};

const planCollect = async (
  run: RunTuicr,
  review: Review,
  originals: ReadonlyMap<string, string>,
): Promise<CollectedRecord> => {
  const reviewed = await readReviewedComments(run, review);

  const planned = await Promise.all(
    review.paths.map((path) => planEdit(review, path, originals.get(path) ?? '')),
  );

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
    const original = await readRequired(review, edit.path);
    // oxlint-disable-next-line no-await-in-loop -- Each recheck must sit right before its write.
    const current = await readOptional(realPath);
    const decision = decideEdit({ path: edit.path, original, staged: edit.staged, current });

    // A file that disappears before the write is a conflict, like one missing at the read.
    const written =
      decision === 'apply' &&
      // oxlint-disable-next-line no-await-in-loop -- Each write follows its own recheck.
      (await writeDestination(review.tauDirectory, edit.path, edit.staged).catch(
        (error: unknown) => {
          throw refusalWithProgress(error, record);
        },
      ));

    edit.status = written ? 'applied' : 'conflict';
    // oxlint-disable-next-line no-await-in-loop -- Save each outcome so a retry never re-decides it.
    await saveCollectedRecord(review.recordDirectory, record);
  }
};

const readOriginals = async (review: Review): Promise<Map<string, string>> => {
  const entries = await Promise.all(
    review.paths.map(async (path) => [path, await readRequired(review, path)] as const),
  );

  return new Map(entries);
};

const requireReviewedPaths = (review: Review, saved: CollectedRecord): void => {
  const paths = [...saved.comments, ...saved.edits].map(({ path }) => path);
  const stranger = paths.find((path) => !review.paths.includes(path));

  if (stranger !== undefined) {
    throw new CollectRefusalError(
      `draft_review refused the saved plan in ${review.recordDirectory}: ${stranger} is not a file of this review.`,
    );
  }
};

const requireWritableEdits = async (review: Review, record: CollectedRecord): Promise<void> => {
  const pending = record.edits.filter(({ status }) => status === 'pending');

  await Promise.all(
    pending.map((edit) => requireWritableDestination(review.tauDirectory, edit.path)),
  );
};

const checkBeforeChanges = async (
  run: RunTuicr,
  review: Review,
  saved: CollectedRecord | undefined,
): Promise<CollectedRecord> => {
  const originals = await readOriginals(review);

  if (saved !== undefined) {
    requireReviewedPaths(review, saved);
  }

  const record = saved ?? (await planCollect(run, review, originals));

  await requireWritableEdits(review, record);

  return record;
};

// The one gate before collect changes anything. It checks the originals, the saved plan paths, and
// every pending destination, so a refusal leaves the comments, the files, and the record as they
// were.
const prepareCollect = async (run: RunTuicr, review: Review): Promise<CollectedRecord> => {
  const saved = await loadCollectedRecord(review.recordDirectory);
  let record: CollectedRecord;

  try {
    record = await checkBeforeChanges(run, review, saved);
  } catch (error) {
    throw refusalWithProgress(error, saved);
  }

  if (saved === undefined) {
    await saveCollectedRecord(review.recordDirectory, record);
  }

  return record;
};

export const collectReview = async (run: RunTuicr, review: Review): Promise<Collected> => {
  const record = await prepareCollect(run, review);

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
