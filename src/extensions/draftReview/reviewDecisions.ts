export interface SessionComment {
  id: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  type: string;
  content: string;
}

export interface FileFacts {
  path: string;
  // The file as it was when the review began.
  original: string;
  // The staged file after the review, or undefined when the user removed it.
  staged: string | undefined;
  // The real file now, or undefined when it is gone.
  current: string | undefined;
}

export type EditDecision = 'unchanged' | 'apply' | 'conflict';

// Session-level comments have no path and belong to no reviewed file.
export const selectReviewedComments = (
  comments: readonly SessionComment[],
  reviewedPaths: readonly string[],
): SessionComment[] =>
  comments.filter((comment) => comment.path !== null && reviewedPaths.includes(comment.path));

// A changed file is written back only while the real file still matches what the review began with.
export const decideEdit = (facts: FileFacts): EditDecision => {
  if (facts.staged === undefined || facts.staged === facts.original) {
    return 'unchanged';
  }

  return facts.current === facts.original ? 'apply' : 'conflict';
};
