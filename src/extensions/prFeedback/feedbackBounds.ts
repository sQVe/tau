import type { PullRequestFeedback } from './read.js';
import type { Comment, Review, Thread } from './threads.js';

type FeedbackList = 'threads' | 'reviews' | 'comments';

interface ListGap {
  kind: 'truncatedList';
  list: FeedbackList;
  kept: number;
  total: number;
}

interface BodyGap {
  kind: 'truncatedBody';
  list: FeedbackList;
  id: number;
  kept: number;
  total: number;
}

type FeedbackGap = ListGap | BodyGap;

interface BoundedFeedback extends PullRequestFeedback {
  directory: string;
  feedback: string;
  gaps: FeedbackGap[];
}

type ChunkedBody<T> = Omit<T, 'body'> & { body: string[] };

interface SavedFeedback extends Omit<PullRequestFeedback, FeedbackList> {
  threads: (Omit<Thread, 'comments'> & { comments: ChunkedBody<Thread['comments'][number]>[] })[];
  reviews: ChunkedBody<Review>[];
  comments: ChunkedBody<Comment>[];
}

const bodyCharacterLimit = 4000;
const resultCharacterLimit = 40_000;

const chunkBody = <T extends { body: string }>(item: T) => {
  const { body, ...metadata } = item;
  const chunks: string[] = [];

  for (let index = 0; index < body.length; index += bodyCharacterLimit) {
    chunks.push(body.slice(index, index + bodyCharacterLimit));
  }

  return { ...metadata, body: chunks };
};

export const chunkFeedbackBodies = (full: PullRequestFeedback): SavedFeedback => ({
  ...full,
  threads: full.threads.map((thread) => ({
    ...thread,
    comments: thread.comments.map(chunkBody),
  })),
  reviews: full.reviews.map(chunkBody),
  comments: full.comments.map(chunkBody),
});

const boundBody = <T extends Comment>(item: T, list: FeedbackList, gaps: FeedbackGap[]): T => {
  if (item.body.length <= bodyCharacterLimit) {
    return item;
  }

  gaps.push({
    kind: 'truncatedBody',
    list,
    id: item.id,
    kept: bodyCharacterLimit,
    total: item.body.length,
  });

  return { ...item, body: item.body.slice(0, bodyCharacterLimit) };
};

const boundItem = <T extends Thread | Review | Comment>(item: T, list: FeedbackList) => {
  const gaps: FeedbackGap[] = [];

  if ('comments' in item) {
    const comments = item.comments.map((comment) => boundBody(comment, list, gaps));

    return { item: { ...item, comments }, gaps };
  }

  const bounded = boundBody(item, list, gaps);

  return { item: { ...item, body: bounded.body }, gaps };
};

const serializedSize = (value: BoundedFeedback) => JSON.stringify(value, null, 2).length;

const appendList = <T extends Thread | Review | Comment>(
  result: BoundedFeedback,
  gap: ListGap,
  items: T[],
  destination: T[],
) => {
  for (const item of items) {
    const bounded = boundItem(item, gap.list);
    const previousGapCount = result.gaps.length;

    destination.push(bounded.item);
    result.gaps.push(...bounded.gaps);
    gap.kept += 1;

    if (serializedSize(result) > resultCharacterLimit) {
      destination.pop();
      result.gaps.splice(previousGapCount);
      gap.kept -= 1;

      return;
    }
  }

  result.gaps.splice(result.gaps.indexOf(gap), 1);
};

export const boundFeedback = (
  full: PullRequestFeedback,
  paths: { directory: string; feedback: string },
): BoundedFeedback => {
  const lists = ['threads', 'reviews', 'comments'] as const;

  const gaps: ListGap[] = lists.map((list) => ({
    kind: 'truncatedList',
    list,
    kept: 0,
    total: full[list].length,
  }));

  const result: BoundedFeedback = {
    ...full,
    ...paths,
    threads: [],
    reviews: [],
    comments: [],
    gaps: [...gaps],
  };

  if (serializedSize(result) > resultCharacterLimit) {
    throw new Error(
      `Feedback metadata exceeds the result character limit. Read ${paths.feedback} for the full result.`,
    );
  }

  for (const gap of gaps) {
    appendList<Thread | Review | Comment>(result, gap, full[gap.list], result[gap.list]);
  }

  return result;
};
