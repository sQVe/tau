import { isDeepStrictEqual } from 'node:util';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { postIssueComment, postReply, resolveThread, UnreadWriteOutputError } from './github.js';
import type { Repository, Runtime } from './github.js';
import { readFeedback } from './read.js';
import type { PullRequestFeedback } from './read.js';
import { readPosted, readPullRequestRecord, readReplies, writePosted } from './replies.js';
import type { Posted, PostedWrite, Replies } from './replies.js';
import { personWrites, planWrites } from './writes.js';
import type { PlannedWrite } from './writes.js';

export interface PostInput {
  stateToken: string;
  head: string;
}

interface WriteTarget {
  runtime: Runtime;
  repository: Repository;
  pr: number;
}

interface SavedWork {
  replies: Replies;
  posted: Posted;
}

interface WriteSummary {
  kind: PlannedWrite['kind'];
  thread: string | null;
  url: string;
  text: string | null;
}

// Carries the writes a failed post made and did not make, so the caller can report both.
class PostError extends Error {
  readonly posted: PostedWrite[];
  readonly notPosted: WriteSummary[];

  constructor(
    message: string,
    failure: { posted: PostedWrite[]; notPosted: WriteSummary[] },
    options: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PostError';
    this.posted = failure.posted;
    this.notPosted = failure.notPosted;
  }
}

const summarize = ({ kind, thread, url, text }: PlannedWrite): WriteSummary => ({
  kind,
  thread,
  url,
  text,
});

const describeWrite = (write: WriteSummary) => {
  if (write.kind === 'resolve') {
    return `Resolve ${write.url}`;
  }

  const action = write.kind === 'reply' ? 'Reply to' : 'Comment on';

  return `${action} ${write.url}:\n${write.text ?? ''}`;
};

const bulletList = (writes: readonly WriteSummary[]) =>
  writes.length === 0 ? '- none' : writes.map((write) => `- ${describeWrite(write)}`).join('\n');

const rejectChangedFeedback = (feedback: PullRequestFeedback, input: PostInput) => {
  if (feedback.stateToken !== input.stateToken) {
    throw new Error(
      'A person added, edited, or deleted a comment since the read, or stateToken is wrong. Call read again. Nothing was posted.',
    );
  }

  if (feedback.pr.headRefOid !== input.head) {
    throw new Error(
      `The pull request head is ${feedback.pr.headRefOid}, not ${input.head}. Push first, or pass the head you pushed. Nothing was posted.`,
    );
  }
};

const readCheckedFeedback = async (target: WriteTarget, input: PostInput) => {
  const feedback = await readFeedback(target.runtime, target.repository, target.pr);

  rejectChangedFeedback(feedback, input);

  return feedback;
};

// Returns the new comment ID, or null for a resolve.
const makeWrite = async (target: WriteTarget, write: PlannedWrite) => {
  const { runtime, repository, pr } = target;

  if (write.kind === 'resolve') {
    await resolveThread(runtime, repository, write.thread);

    return null;
  }

  if (write.kind === 'reply') {
    return postReply(runtime, repository, { pr, replyTo: write.replyTo, body: write.text });
  }

  return postIssueComment(runtime, repository, { pr, body: write.text });
};

// A write whose output gh printed but the tool could not read counts as posted, without an ID.
const postWrite = async (target: WriteTarget, write: PlannedWrite) => {
  try {
    const commentId = await makeWrite(target, write);

    return { record: { ...summarize(write), commentId }, unread: undefined };
  } catch (error) {
    if (!(error instanceof UnreadWriteOutputError)) {
      throw error;
    }

    return { record: { ...summarize(write), commentId: null }, unread: error };
  }
};

const savePosted = async (directory: string, writes: readonly PostedWrite[]) => {
  try {
    await writePosted(directory, writes);
  } catch (error) {
    throw new Error(
      `GitHub has the last posted write, but saving ${directory}/posted.json failed: ${errorMessage(error)}. Add that write to posted.json before a retry.`,
      { cause: error },
    );
  }
};

const failedPost = (
  directory: string,
  failure: { posted: PostedWrite[]; notPosted: WriteSummary[] },
  error: unknown,
) =>
  new PostError(
    `A pr_feedback write failed: ${errorMessage(error)}\nPosted:\n${bulletList(failure.posted)}\nNot posted:\n${bulletList(failure.notPosted)}\n${directory}/posted.json records the posted writes, and a retry skips them.`,
    failure,
    { cause: error },
  );

// Records each write as soon as GitHub has it, so a retry skips it.
const makeWrites = async (
  target: WriteTarget,
  directory: string,
  writes: readonly PlannedWrite[],
  recorded: readonly PostedWrite[],
) => {
  const posted: PostedWrite[] = [];

  for (const [index, write] of writes.entries()) {
    const postedBefore = posted.length;

    try {
      // oxlint-disable-next-line no-await-in-loop -- Writes run in file order and stop at the first failure.
      const outcome = await postWrite(target, write);

      posted.push(outcome.record);
      // oxlint-disable-next-line no-await-in-loop -- Each write is recorded before the next one starts.
      await savePosted(directory, [...recorded, ...posted]);

      if (outcome.unread !== undefined) {
        throw outcome.unread;
      }
    } catch (error) {
      const firstNotPosted = posted.length > postedBefore ? index + 1 : index;
      const notPosted = writes.slice(firstNotPosted).map((other) => summarize(other));

      throw failedPost(directory, { posted, notPosted }, error);
    }
  }

  return posted;
};

const confirmMessage = (writes: readonly PlannedWrite[]) =>
  writes.map((write, index) => `${index + 1}. ${describeWrite(write)}`).join('\n\n');

const planFromFeedback = (saved: SavedWork, feedback: PullRequestFeedback) =>
  planWrites({
    entries: saved.replies.threads,
    comment: saved.replies.comment,
    threads: feedback.threads,
    reviews: feedback.reviews,
    comments: feedback.comments,
    prUrl: feedback.pr.url,
    recorded: saved.posted.writes,
  });

const changedPlan = (reason: string, options?: ErrorOptions) =>
  new Error(
    `The pull request changed during the confirm, so the writes differ from the confirmed ones: ${reason}. Call read again. Nothing was posted.`,
    options,
  );

// A thread can be resolved, or a permission can change, without changing the token or the head.
const rejectChangedPlan = async (
  target: WriteTarget,
  input: PostInput,
  saved: SavedWork,
  confirmed: readonly PlannedWrite[],
) => {
  const feedback = await readCheckedFeedback(target, input);
  let writes: PlannedWrite[];

  try {
    writes = planFromFeedback(saved, feedback);
  } catch (error) {
    throw changedPlan(errorMessage(error), { cause: error });
  }

  if (!isDeepStrictEqual(writes, confirmed)) {
    throw changedPlan('the planned writes are different');
  }
};

// Posts only the writes the read checked. The feedback is read again after the confirm, since the
// user can take any time to answer.
export const postReplies = async (
  runtime: Runtime,
  context: ExtensionContext,
  directory: string,
  input: PostInput,
): Promise<Record<string, unknown>> => {
  const { repository, pr } = await readPullRequestRecord(directory);
  const target = { runtime, repository, pr };
  const replies = await readReplies(directory);
  const posted = await readPosted(directory);
  const saved = { replies, posted };
  const feedback = await readCheckedFeedback(target, input);
  const writes = planFromFeedback(saved, feedback);
  const skipped = posted.writes;

  if (writes.length === 0) {
    return { status: 'unchanged', posted: [], skipped };
  }

  const toPeople = personWrites(writes);

  if (toPeople.length > 0) {
    if (!context.hasUI) {
      throw new Error(
        'Posting to a person needs a session with UI to confirm. Nothing was posted.',
      );
    }

    const confirmed = await context.ui.confirm(
      'Post these replies to people on the pull request?',
      confirmMessage(toPeople),
    );

    if (!confirmed) {
      return { status: 'declined', posted: [], skipped };
    }

    await rejectChangedPlan(target, input, saved, writes);
  }

  return {
    status: 'posted',
    posted: await makeWrites(target, directory, writes, posted.writes),
    skipped,
  };
};
