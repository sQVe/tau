import type { Comment, Review, Thread } from './threads.js';

type WriteKind = 'reply' | 'resolve' | 'comment';

interface WriteTarget {
  url: string;
  toPerson: boolean;
}

export type PlannedWrite = WriteTarget &
  (
    | { kind: 'reply'; thread: string; replyTo: number; text: string }
    | { kind: 'resolve'; thread: string; text: null }
    | { kind: 'comment'; thread: null; text: string }
  );

interface ThreadEntry {
  id: string;
  reply: string | null;
  resolve: boolean;
}

interface CommentEntry {
  body: string;
  answers: string[];
}

export interface WriteFacts {
  entries: ThreadEntry[];
  comment: CommentEntry | null;
  threads: Thread[];
  reviews: Review[];
  comments: Comment[];
  prUrl: string;
  recorded: { kind: WriteKind; thread: string | null }[];
}

export interface RecordedWrite {
  kind: WriteKind;
  thread: string | null;
  url: string;
  text: string | null;
  state: 'posted' | 'uncertain';
  commentId: number | null;
}

export interface SettleFacts {
  recorded: RecordedWrite[];
  viewer: string;
  threads: Thread[];
  comments: Comment[];
}

const writeKey = (write: { kind: WriteKind; thread: string | null }): string =>
  `${write.kind}:${write.thread ?? ''}`;

const entryKinds = (entry: ThreadEntry) => {
  const kinds: WriteKind[] = [];

  if (entry.reply !== null) {
    kinds.push('reply');
  }

  if (entry.resolve) {
    kinds.push('resolve');
  }

  return kinds;
};

const rejectRepeatedEntries = (entries: readonly ThreadEntry[]) => {
  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new Error(`replies.json lists thread ${entry.id} more than once.`);
    }

    seen.add(entry.id);
  }
};

const findThread = (threads: readonly Thread[], id: string) => {
  const thread = threads.find((candidate) => candidate.id === id);

  if (thread === undefined) {
    throw new Error(
      `Thread ${id} in replies.json is not an unresolved thread on the pull request.`,
    );
  }

  return thread;
};

const rejectForbidden = (thread: Thread, kinds: readonly WriteKind[]) => {
  if (kinds.includes('reply') && !thread.viewerCanReply) {
    throw new Error(`Thread ${thread.id} in replies.json has a reply, but you cannot reply to it.`);
  }

  if (kinds.includes('resolve') && !thread.viewerCanResolve) {
    throw new Error(`Thread ${thread.id} in replies.json resolves, but you cannot resolve it.`);
  }
};

const threadWrites = (
  entry: ThreadEntry,
  threads: readonly Thread[],
  recorded: Set<string>,
): PlannedWrite[] => {
  const kinds = entryKinds(entry);

  if (kinds.length === 0) {
    throw new Error(`Thread ${entry.id} in replies.json has no reply and does not resolve.`);
  }

  const missing = kinds.filter((kind) => !recorded.has(writeKey({ kind, thread: entry.id })));

  if (missing.length === 0) {
    return [];
  }

  const thread = findThread(threads, entry.id);

  rejectForbidden(thread, missing);

  const target = { url: thread.comments[0]?.url ?? thread.id, toPerson: thread.fromPerson };
  const writes: PlannedWrite[] = [];

  if (missing.includes('reply') && entry.reply !== null) {
    writes.push({
      ...target,
      kind: 'reply',
      thread: thread.id,
      replyTo: thread.replyTo,
      text: entry.reply,
    });
  }

  if (missing.includes('resolve')) {
    writes.push({ ...target, kind: 'resolve', thread: thread.id, text: null });
  }

  return writes;
};

// A PR comment that answers nothing in particular speaks to everyone, people included. GitHub
// numbers reviews and comments separately, so an ID is a bot only when every source with it is.
const commentToPerson = (comment: CommentEntry, facts: WriteFacts) => {
  const sources = new Map<string, boolean>();

  for (const source of [...facts.reviews, ...facts.comments]) {
    const id = String(source.id);
    const otherIsBot = sources.get(id) ?? true;

    sources.set(id, otherIsBot && source.isBot);
  }

  const answeredBots = comment.answers.map((id) => {
    const isBot = sources.get(id);

    if (isBot === undefined) {
      throw new Error(
        `The comment in replies.json answers ${id}, which is no review or comment on the pull request.`,
      );
    }

    return isBot;
  });

  return answeredBots.length === 0 || answeredBots.includes(false);
};

const commentWrites = (facts: WriteFacts, recorded: Set<string>): PlannedWrite[] => {
  const { comment } = facts;

  if (comment === null || recorded.has(writeKey({ kind: 'comment', thread: null }))) {
    return [];
  }

  return [
    {
      kind: 'comment',
      thread: null,
      url: facts.prUrl,
      text: comment.body,
      toPerson: commentToPerson(comment, facts),
    },
  ];
};

// Plans the writes that are not recorded yet, in file order: per thread the reply, then the
// resolve, and the PR comment last. A thread whose writes are all recorded is not checked, since
// the recorded resolve leaves it out of the unresolved threads.
export const planWrites = (facts: WriteFacts): PlannedWrite[] => {
  const recorded = new Set(facts.recorded.map((write) => writeKey(write)));

  rejectRepeatedEntries(facts.entries);

  const writes = facts.entries.flatMap((entry) => threadWrites(entry, facts.threads, recorded));

  return [...writes, ...commentWrites(facts, recorded)];
};

export const personWrites = (writes: readonly PlannedWrite[]): PlannedWrite[] =>
  writes.filter((write) => write.toPerson);

const writtenComments = (write: RecordedWrite, facts: SettleFacts) => {
  if (write.kind === 'comment') {
    return facts.comments;
  }

  return facts.threads.find((thread) => thread.id === write.thread)?.comments ?? [];
};

// Review replies and PR comments come from separate GitHub endpoints, so their IDs can repeat.
const claimKey = (kind: RecordedWrite['kind'], commentId: number) => `${kind}:${commentId}`;

// Returns the newest comment by the viewer with the write's text that no posted write claims.
const findWrittenComment = (write: RecordedWrite, facts: SettleFacts, claimed: Set<string>) => {
  const matches = writtenComments(write, facts).filter(
    (comment) => comment.author === facts.viewer && comment.body === write.text,
  );

  return matches.findLast((comment) => !claimed.has(claimKey(write.kind, comment.id)));
};

const settleWrite = (write: RecordedWrite, facts: SettleFacts, claimed: Set<string>) => {
  if (write.state === 'posted') {
    return [write];
  }

  // The fresh read lists only unresolved threads, so a missing thread was resolved.
  if (write.kind === 'resolve') {
    const unresolved = facts.threads.some((thread) => thread.id === write.thread);

    return unresolved ? [] : [{ ...write, state: 'posted' as const }];
  }

  const comment = findWrittenComment(write, facts, claimed);

  if (comment === undefined) {
    return [];
  }

  claimed.add(claimKey(write.kind, comment.id));

  return [{ ...write, state: 'posted' as const, commentId: comment.id }];
};

// Decides each uncertain write from a fresh read: a write GitHub has becomes posted, and any other
// is dropped so the plan makes it again. GitHub can hold a write whose gh call failed.
export const settleWrites = (facts: SettleFacts): RecordedWrite[] => {
  const claimed = new Set<string>();

  for (const write of facts.recorded) {
    if (write.state === 'posted' && write.commentId !== null) {
      claimed.add(claimKey(write.kind, write.commentId));
    }
  }

  return facts.recorded.flatMap((write) => settleWrite(write, facts, claimed));
};
