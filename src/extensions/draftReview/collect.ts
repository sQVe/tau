import { basename, join } from 'node:path';

import { errorMessage } from '../../errors.js';
import { readOptionalText } from '../../record.js';
import { loadCollectedRecord, saveCollectedRecord } from './collectedRecord.js';
import type { CollectedRecord } from './collectedRecord.js';
import {
  DestinationRefusalError,
  requireWritableDestination,
  writeDestination,
} from './destination.js';
import { diffFiles } from './diff.js';
import { decideEdit, decideViewerSource, selectReviewedComments } from './reviewDecisions.js';
import type { FileComment } from './reviewDecisions.js';
import { removeReview } from './stage.js';
import type { Review, ReviewFile } from './stage.js';
import { deleteSessionComment, listSessionPaths, readSessionComments } from './tuicrSession.js';
import type { RunTuicr } from './tuicrSession.js';
import { readViewerComments, ViewerProtocolRefusalError } from './viewerProtocol.js';
import type { ViewerComment } from './viewerProtocol.js';

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
  comment: FileComment;
}

interface PreparedCollect {
  record: CollectedRecord;
  viewerComments: ViewerComment[] | undefined;
}

// tuicr names each file by its staged path; collect names it by its `.tau` path.
const readReviewedComments = async (
  run: RunTuicr,
  review: Review,
): Promise<SessionCommentRef[]> => {
  const sessionPaths = await listSessionPaths(run, review.stagingDirectory);

  const found = await Promise.all(
    sessionPaths.map(async (sessionPath) => {
      const comments = await readSessionComments(run, sessionPath);
      const kept = selectReviewedComments(comments, review.files);

      return kept.map((comment) => ({ sessionPath, comment }));
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
  const original = await readOptionalText(originalPathOf(review, path));

  if (original === undefined) {
    throw new CollectRefusalError(
      `draft_review cannot collect ${path}: its saved original is missing from ${review.recordDirectory}.`,
    );
  }

  return original;
};

const isRefusal = (error: unknown) =>
  error instanceof CollectRefusalError ||
  error instanceof DestinationRefusalError ||
  error instanceof ViewerProtocolRefusalError;

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

const planEdit = async (review: Review, { path, stagedPath }: ReviewFile, original: string) => {
  const originalPath = originalPathOf(review, path);
  const stagedFilePath = join(review.stagingDirectory, stagedPath);
  const staged = await readOptionalText(stagedFilePath);

  if (staged === undefined || staged === original) {
    return [];
  }

  const diff = await diffFiles(originalPath, stagedFilePath, path);

  return [{ path, diff, staged, status: 'pending' as const }];
};

const planEdits = async (review: Review, originals: ReadonlyMap<string, string>) => {
  const planned = await Promise.all(
    review.files.map((file) => planEdit(review, file, originals.get(file.path) ?? '')),
  );

  return planned.flat();
};

const planViewerRecord = async (
  review: Review,
  originals: ReadonlyMap<string, string>,
): Promise<CollectedRecord> => ({
  comments: [],
  edits: await planEdits(review, originals),
});

const planTuicrRecord = async (
  run: RunTuicr,
  review: Review,
  originals: ReadonlyMap<string, string>,
): Promise<CollectedRecord> => {
  const reviewed = await readReviewedComments(run, review);

  const comments = reviewed.map(({ sessionPath, comment }) => ({
    sessionPath,
    id: comment.id,
    deleted: false,
    path: comment.path,
    startLine: comment.startLine,
    endLine: comment.endLine,
    type: comment.type,
    content: comment.content,
  }));

  return { comments, edits: await planEdits(review, originals) };
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
    const current = await readOptionalText(realPath);
    const decision = decideEdit({ path: edit.path, original, staged: edit.staged, current });

    // A file that disappears before the write is a conflict, like one missing at the read.
    const written =
      current !== undefined &&
      decision === 'apply' &&
      // oxlint-disable-next-line no-await-in-loop -- Each write follows its own recheck.
      (await writeDestination(review.tauDirectory, edit.path, edit.staged, current).catch(
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
    review.files.map(async ({ path }) => [path, await readRequired(review, path)] as const),
  );

  return new Map(entries);
};

const requireReviewedPaths = (review: Review, saved: CollectedRecord): void => {
  const reviewedPaths = new Set(review.files.map(({ path }) => path));
  const paths = [...saved.comments, ...saved.edits].map(({ path }) => path);
  const stranger = paths.find((path) => !reviewedPaths.has(path));

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
): Promise<PreparedCollect> => {
  const originals = await readOriginals(review);

  if (saved !== undefined) {
    requireReviewedPaths(review, saved);
  }

  const viewerComments = await readViewerComments(
    review.recordDirectory,
    basename(review.recordDirectory),
    review.files,
  );

  const source = decideViewerSource({
    savedTuicrComments: saved?.comments.length ?? 0,
    viewerReplyExists: viewerComments !== undefined,
  });

  if (source === 'refuse-switch') {
    throw new CollectRefusalError(
      `draft_review refused the viewer reply in ${review.recordDirectory}: the review began collecting tuicr comments, so a retry cannot switch to a viewer reply. Finish the tuicr collect or open a new review.`,
    );
  }

  const record =
    saved ??
    (viewerComments === undefined
      ? await planTuicrRecord(run, review, originals)
      : await planViewerRecord(review, originals));

  await requireWritableEdits(review, record);

  return { record, viewerComments };
};

// The one gate before collect changes anything. It checks the originals, the saved plan paths, and
// every pending destination, so a refusal leaves the comments, the files, and the record as they
// were.
const prepareCollect = async (run: RunTuicr, review: Review): Promise<PreparedCollect> => {
  const saved = await loadCollectedRecord(review.recordDirectory);
  let prepared: PreparedCollect;

  try {
    prepared = await checkBeforeChanges(run, review, saved);
  } catch (error) {
    throw refusalWithProgress(error, saved);
  }

  if (saved === undefined) {
    await saveCollectedRecord(review.recordDirectory, prepared.record);
  }

  return prepared;
};

export const collectReview = async (run: RunTuicr, review: Review): Promise<Collected> => {
  const { record, viewerComments } = await prepareCollect(run, review);

  await deleteComments(run, review, record);
  await writeBack(review, record);
  await removeReview(review);

  const commentSource = viewerComments ?? record.comments;

  const comments = commentSource.map((comment) => ({
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
