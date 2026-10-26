import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { CommandRuntime } from '../../command.js';
import { confirmWithUser } from '../../dialog/dialog.js';
import { errorMessage } from '../../errors.js';
import { withFileLock } from '../../fileLock/fileLock.js';
import type { Repository } from '../../github/github.js';
import type { GroupExec } from '../../process/process.js';
import {
  postIssueComment,
  postReply,
  resolveThread,
  UncertainWriteError,
  UnreadWriteOutputError,
} from './github.js';
import { readFeedback } from './read.js';
import type { PullRequestFeedback } from './read.js';
import { readPosted, readPullRequestRecord, readReplies, writePosted } from './replies.js';
import type { PostedWrite, Replies } from './replies.js';
import type { Thread } from './threads.js';
import { planWrites, settleWrites, targetCommentIds } from './writes.js';
import type { PlannedWrite } from './writes.js';

export interface PostRuntime extends CommandRuntime {
  execInGroup: GroupExec;
}

export interface PostInput {
  stateToken: string;
  head: string;
}

interface WriteTarget {
  runtime: CommandRuntime;
  repository: Repository;
  pr: number;
}

interface SavedWork {
  replies: Replies;
  recorded: PostedWrite[];
}

interface WriteSummary {
  kind: PlannedWrite['kind'];
  thread: string | null;
  url: string;
  text: string | null;
}

interface PostFailure {
  posted: PostedWrite[];
  notPosted: WriteSummary[];
  uncertain?: PostedWrite[];
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

const postedRecord = (write: PlannedWrite, commentId: number | null): PostedWrite => ({
  ...summarize(write),
  state: 'posted',
  commentId,
  earlierCommentIds: [],
});

const uncertainRecord = (write: PlannedWrite, feedback: PullRequestFeedback): PostedWrite => ({
  ...summarize(write),
  state: 'uncertain',
  commentId: null,
  earlierCommentIds: targetCommentIds(write, feedback),
});

const postWrite = async (target: WriteTarget, write: PlannedWrite, uncertain: PostedWrite) => {
  try {
    const commentId = await makeWrite(target, write);

    return { record: postedRecord(write, commentId), error: undefined };
  } catch (error) {
    if (error instanceof UnreadWriteOutputError) {
      return { record: postedRecord(write, null), error };
    }

    if (error instanceof UncertainWriteError) {
      return { record: uncertain, error };
    }

    throw error;
  }
};

const failedPost = (directory: string, failure: PostFailure, error: unknown) =>
  new Error(
    `A pr_feedback write failed: ${errorMessage(error)}\nPosted:\n${bulletList(failure.posted)}\nNot posted:\n${bulletList(failure.notPosted)}\n${directory}/posted.json records the posted writes, and a retry skips them.`,
    { cause: error },
  );

const uncertainPost = (directory: string, failure: PostFailure, error: unknown) =>
  new Error(
    `A pr_feedback write failed, and its outcome is uncertain: GitHub may have it. ${errorMessage(error)}\nUncertain:\n${bulletList(failure.uncertain ?? [])}\nPosted:\n${bulletList(failure.posted)}\nNot posted:\n${bulletList(failure.notPosted)}\n${directory}/posted.json records the uncertain write. A retry checks GitHub for it and posts it only if GitHub does not have it.`,
    { cause: error },
  );

const unsavedBeforeWrite = (
  directory: string,
  failure: PostFailure,
  unsent: PostedWrite,
  error: unknown,
) =>
  new Error(
    `Saving ${directory}/posted.json before a write failed, so the write was not sent: ${errorMessage(error)}\n${describeWrite(unsent)}\nPosted:\n${bulletList(failure.posted)}\nNot posted:\n${bulletList(failure.notPosted)}\nposted.json records the posted writes, and a retry skips them.`,
    { cause: error },
  );

const unsavedPost = (
  directory: string,
  failure: PostFailure,
  unsaved: PostedWrite,
  error: unknown,
) =>
  new Error(
    `GitHub has this write, but saving ${directory}/posted.json failed: ${errorMessage(error)}\n${describeWrite(unsaved)}\nposted.json records it as uncertain, so a retry checks GitHub for it and does not post it again.\nPosted:\n${bulletList(failure.posted)}\nNot posted:\n${bulletList(failure.notPosted)}\nposted.json records the other posted writes, and a retry skips them.`,
    { cause: error },
  );

const summarizeFrom = (writes: readonly PlannedWrite[], start: number) =>
  writes.slice(start).map((write) => summarize(write));

const dropUncertain = async (directory: string, writes: readonly PostedWrite[]) => {
  try {
    await writePosted(directory, writes);
  } catch {
    // The failed write is the error to report.
  }
};

const makeWrites = async (
  target: WriteTarget,
  directory: string,
  writes: readonly PlannedWrite[],
  feedback: PullRequestFeedback,
  recorded: readonly PostedWrite[],
) => {
  const posted: PostedWrite[] = [];

  for (const [index, write] of writes.entries()) {
    const uncertain = uncertainRecord(write, feedback);
    const notSent = summarizeFrom(writes, index);

    try {
      // oxlint-disable-next-line no-await-in-loop -- Each write is recorded before it is sent.
      await writePosted(directory, [...recorded, ...posted, uncertain]);
    } catch (error) {
      throw unsavedBeforeWrite(directory, { posted, notPosted: notSent }, uncertain, error);
    }

    let outcome: Awaited<ReturnType<typeof postWrite>>;

    try {
      // oxlint-disable-next-line no-await-in-loop -- Writes run in file order and stop at the first failure.
      outcome = await postWrite(target, write, uncertain);
    } catch (error) {
      // oxlint-disable-next-line no-await-in-loop -- The post stops after this write.
      await dropUncertain(directory, [...recorded, ...posted]);

      throw failedPost(directory, { posted, notPosted: notSent }, error);
    }

    const notPosted = summarizeFrom(writes, index + 1);

    if (outcome.record.state === 'uncertain') {
      throw uncertainPost(
        directory,
        { posted, notPosted, uncertain: [outcome.record] },
        outcome.error,
      );
    }

    posted.push(outcome.record);

    try {
      // oxlint-disable-next-line no-await-in-loop -- Each write is recorded before the next one starts.
      await writePosted(directory, [...recorded, ...posted]);
    } catch (error) {
      throw unsavedPost(directory, { posted, notPosted }, outcome.record, error);
    }

    if (outcome.error !== undefined) {
      throw failedPost(directory, { posted, notPosted }, outcome.error);
    }
  }

  return posted;
};

const quoteLength = 72;

const plural = (count: number, singular: string, several: string) =>
  `${count} ${count === 1 ? singular : several}`;

const confirmTitle = (writes: readonly PlannedWrite[], pr: number) => {
  const resolves = writes.filter((write) => write.kind === 'resolve').length;
  const replies = writes.length - resolves;
  const actions: string[] = [];

  if (replies > 0) {
    actions.push(`post ${plural(replies, 'reply', 'replies')} to people`);
  }

  if (resolves > 0) {
    actions.push(`resolve ${plural(resolves, 'thread', 'threads')}`);
  }

  const sentence = `${actions.join(' and ')} on PR #${pr}?`;

  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
};

const indent = (text: string) =>
  text
    .split('\n')
    .map((line) => (line === '' ? '' : `   ${line}`))
    .join('\n');

const quote = (body: string) => {
  const line = body.replaceAll(/\s+/gu, ' ').trim();
  const ellipsis = '...';
  const kept = quoteLength - ellipsis.length;
  const shortened = line.length > quoteLength ? `${line.slice(0, kept)}${ellipsis}` : line;

  return `> ${shortened}`;
};

const threadPlace = (thread: Thread) =>
  thread.line === null ? thread.path : `${thread.path}:${thread.line}`;

const threadSummary = (thread: Thread) => {
  const answered =
    thread.comments.find((comment) => comment.id === thread.replyTo) ?? thread.comments[0];

  const author = answered?.author ?? null;
  const who = author === null ? 'A deleted user' : `@${author}`;
  const quoted = answered === undefined ? [] : [quote(answered.body)];

  return { heading: `${who} on ${threadPlace(thread)}`, quoted };
};

const confirmItem = (write: PlannedWrite, feedback: PullRequestFeedback) => {
  if (write.kind === 'comment') {
    return [`Comment on PR #${feedback.pr.number}`, indent(write.text)].join('\n');
  }

  const thread = feedback.threads.find((candidate) => candidate.id === write.thread);

  if (thread === undefined) {
    return describeWrite(write);
  }

  const { heading, quoted } = threadSummary(thread);

  if (write.kind === 'resolve') {
    return [`Resolve the thread of ${heading}`, ...quoted.map((line) => indent(line))].join('\n');
  }

  return [heading, ...quoted.map((line) => indent(line)), indent(write.text)].join('\n');
};

const confirmMessage = (writes: readonly PlannedWrite[], feedback: PullRequestFeedback) =>
  writes.map((write, index) => `${index + 1}. ${confirmItem(write, feedback)}`).join('\n\n');

const planFromFeedback = (saved: SavedWork, feedback: PullRequestFeedback) =>
  planWrites({
    entries: saved.replies.threads,
    comment: saved.replies.comment,
    threads: feedback.threads,
    reviews: feedback.reviews,
    comments: feedback.comments,
    prUrl: feedback.pr.url,
    recorded: saved.recorded,
  });

const changedPlan = (reason: string, options?: ErrorOptions) =>
  new Error(
    `The pull request or posted.json changed after the plan, so the writes differ from the planned ones: ${reason}. Call read again. Nothing was posted.`,
    options,
  );

const settleFrom = (
  recorded: PostedWrite[],
  feedback: PullRequestFeedback,
  unmatched: 'drop' | 'keep',
) =>
  settleWrites({
    recorded,
    unmatched,
    viewer: feedback.viewer,
    threads: feedback.threads,
    comments: feedback.comments,
  });

// posted.json can hold uncertain writes, so it is read with the feedback that settles them.
const readRecorded = async (directory: string, feedback: PullRequestFeedback) => {
  const posted = await readPosted(directory);

  return settleFrom(posted.writes, feedback, 'drop');
};

const rejectChangedPlan = async (
  target: WriteTarget,
  directory: string,
  input: PostInput,
  replies: Replies,
  confirmed: readonly PlannedWrite[],
) => {
  const feedback = await readCheckedFeedback(target, input);
  const recorded = await readRecorded(directory, feedback);
  let writes: PlannedWrite[];

  try {
    writes = planFromFeedback({ replies, recorded }, feedback);
  } catch (error) {
    throw changedPlan(errorMessage(error), { cause: error });
  }

  if (!isDeepStrictEqual(writes, confirmed)) {
    throw changedPlan('the planned writes are different');
  }

  return { feedback, recorded };
};

// Saves the uncertain writes that GitHub turned out to have, when no write is left to post. It
// settles posted.json as read now, so writes another session saved since the first read stay. An
// uncertain write the feedback does not show stays uncertain for the next post to settle.
const saveSettled = async (directory: string, feedback: PullRequestFeedback) => {
  const saved = await readPosted(directory);

  const settled = settleFrom(saved.writes, feedback, 'keep');

  if (!isDeepStrictEqual(saved.writes, settled)) {
    await writePosted(directory, settled);
  }
};

const lockFileName = 'post.lock';

// The poll runs only when two sessions link the lock at once. The loser then finds the winner.
const lockPollMilliseconds = 50;

const busyRound = (directory: string) =>
  new Error(
    `Another pr_feedback post is posting ${directory}. Call read again after it finishes. Nothing was posted.`,
  );

const withRoundLock = <Value>(
  runtime: CommandRuntime,
  directory: string,
  run: (recordCommandGroup: (groupId: number) => Promise<void>) => Promise<Value>,
): Promise<Value> =>
  withFileLock(
    {
      lockPath: join(directory, lockFileName),
      checkout: directory,
      signal: runtime.signal,
      pollMilliseconds: lockPollMilliseconds,
      cancelled: () =>
        new Error('The post was cancelled before it took the round. Nothing was posted.'),
      onWaiting: () => {
        throw busyRound(directory);
      },
    },
    run,
  );

// Runs each write in a process group that the round lock records, so the lock stays held while a
// write runs, even after this session dies.
const lockedWrites = (
  runtime: PostRuntime,
  recordCommandGroup: (groupId: number) => Promise<void>,
): CommandRuntime => ({
  cwd: runtime.cwd,
  signal: runtime.signal,
  exec: (command, commandArguments) =>
    runtime.execInGroup(command, commandArguments, {
      cwd: runtime.cwd,
      signal: runtime.signal,
      onStarted: recordCommandGroup,
    }),
});

export const postReplies = async (
  runtime: PostRuntime,
  context: ExtensionContext,
  checkDirectory: () => Promise<string>,
  input: PostInput,
): Promise<Record<string, unknown>> => {
  const directory = await checkDirectory();
  const { repository, pr } = await readPullRequestRecord(directory);
  const target = { runtime, repository, pr };
  const replies = await readReplies(directory);
  const feedback = await readCheckedFeedback(target, input);
  const recorded = await readRecorded(directory, feedback);
  const writes = planFromFeedback({ replies, recorded }, feedback);
  const skipped = recorded;

  if (writes.length === 0) {
    await withRoundLock(runtime, directory, () => saveSettled(directory, feedback));

    return { status: 'unchanged', posted: [], skipped };
  }

  const toPeople = writes.filter((write) => write.toPerson);

  if (toPeople.length > 0) {
    const confirmed = await confirmWithUser(context, {
      action: 'Posting to a person',
      title: confirmTitle(toPeople, feedback.pr.number),
      message: confirmMessage(toPeople, feedback),
    });

    if (!confirmed) {
      return { status: 'declined', posted: [], skipped };
    }

    await checkDirectory();
  }

  const posted = await withRoundLock(runtime, directory, async (recordCommandGroup) => {
    const round = await rejectChangedPlan(target, directory, input, replies, writes);
    const writeTarget = { ...target, runtime: lockedWrites(runtime, recordCommandGroup) };

    return makeWrites(writeTarget, directory, writes, round.feedback, round.recorded);
  });

  return { status: 'posted', posted, skipped };
};
