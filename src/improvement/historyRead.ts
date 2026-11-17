import type { Static, TSchema } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

type CheckOutput = <Schema extends TSchema>(
  label: string,
  schema: Schema,
  value: unknown,
) => asserts value is Static<Schema>;

export type HistoryCoverage = 'complete' | 'partial' | 'unknown';

export interface HistoryRevert {
  projectRoot: string;
  commit: string;
  subject: string;
}

export interface HistoryReview {
  url: string;
  author: string;
  state: string;
  body: string;
}

export interface HistoryComment {
  url: string;
  author: string;
  body: string;
}

export interface HistoryGap {
  source: string;
  reason: string;
}

export interface HistoryResult {
  reverts: HistoryRevert[];
  reviews: HistoryReview[];
  comments: HistoryComment[];
  coverage: HistoryCoverage;
  gaps: HistoryGap[];
}

export interface CappedList {
  entries: string[];
  gap: HistoryGap | undefined;
}

const maximumProjectRoots = 10;
const maximumPullRequests = 20;
const revertWindowDays = 30;
const maximumBodyLength = 2_000;

const outputPreviewLength = 200;

const authorSchema = Type.Union([Type.Object({ login: Type.String() }), Type.Null()]);

const reviewViewSchema = Type.Object({
  reviews: Type.Array(
    Type.Object({
      author: authorSchema,
      state: Type.String(),
      body: Type.String(),
    }),
  ),
  comments: Type.Array(
    Type.Object({
      author: authorSchema,
      body: Type.String(),
    }),
  ),
});

const inlineCommentSchema = Type.Array(
  Type.Object({
    user: authorSchema,
    body: Type.String(),
  }),
);

const capList = (entries: readonly string[], maximum: number, source: string): CappedList => {
  if (entries.length <= maximum) {
    return { entries: [...entries], gap: undefined };
  }

  return {
    entries: entries.slice(0, maximum),
    gap: { source, reason: `capped at ${maximum}` },
  };
};

export const capProjectRoots = (projectRoots: readonly string[]): CappedList =>
  capList(projectRoots, maximumProjectRoots, 'projectRoots');

export const capPullRequests = (pullRequests: readonly string[]): CappedList =>
  capList(pullRequests, maximumPullRequests, 'pullRequests');

export const decideCoverage = (
  readSources: number,
  gaps: readonly HistoryGap[],
): HistoryCoverage => {
  if (readSources === 0) {
    return 'unknown';
  }

  return gaps.length === 0 ? 'complete' : 'partial';
};

export const revertLogArguments = (projectRoot: string): string[] => [
  '-C',
  projectRoot,
  'log',
  `--since=${revertWindowDays}.days`,
  '--grep=Revert',
  '--format=%H%x09%s',
];

export const pullRequestViewArguments = (url: string): string[] => [
  'pr',
  'view',
  url,
  '--json',
  'reviews,comments',
];

const pullRequestPathPattern = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/u;

export const inlineCommentArguments = (url: string): string[] => {
  const match = pullRequestPathPattern.exec(url);

  if (match === null) {
    throw new Error(
      `pull request URL must be https://github.com/<owner>/<name>/pull/<number>, not ${url}.`,
    );
  }

  const [, owner = '', name = '', number = ''] = match;

  return ['api', `repos/${owner}/${name}/pulls/${number}/comments`];
};

const parseJson = (label: string, stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${label} printed output that is not JSON: ${stdout.slice(0, outputPreviewLength)}`,
      { cause: error },
    );
  }
};

const checkOutput: CheckOutput = (label, schema, value) => {
  if (!Value.Check(schema, value)) {
    throw new Error(`${label} printed unexpected output.`);
  }
};

const authorName = (author: Static<typeof authorSchema>): string =>
  author === null ? 'ghost' : author.login;

export const truncateBody = (
  url: string,
  body: string,
): { body: string; gap: HistoryGap | undefined } => {
  if (body.length <= maximumBodyLength) {
    return { body, gap: undefined };
  }

  return {
    body: body.slice(0, maximumBodyLength),
    gap: { source: url, reason: `body truncated at ${maximumBodyLength} characters` },
  };
};

export const parseReverts = (projectRoot: string, stdout: string): HistoryRevert[] => {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');

  return lines.map((line, index) => {
    const separator = line.indexOf('\t');
    const commit = separator === -1 ? '' : line.slice(0, separator);
    const subject = separator === -1 ? '' : line.slice(separator + 1);

    if (commit === '' || subject === '') {
      throw new Error(
        `git log for ${projectRoot} printed unexpected output on line ${index + 1}: ${line}`,
      );
    }

    return { projectRoot, commit, subject };
  });
};

export const parseReviewView = (
  url: string,
  stdout: string,
): { reviews: HistoryReview[]; comments: HistoryComment[]; gaps: HistoryGap[] } => {
  const label = `gh pr view ${url}`;
  const value = parseJson(label, stdout);

  checkOutput(label, reviewViewSchema, value);

  const gaps: HistoryGap[] = [];

  const reviews = value.reviews.map((review) => {
    const truncated = truncateBody(url, review.body);

    if (truncated.gap !== undefined) {
      gaps.push(truncated.gap);
    }

    return {
      url,
      author: authorName(review.author),
      state: review.state,
      body: truncated.body,
    };
  });

  const comments = value.comments.map((comment) => {
    const truncated = truncateBody(url, comment.body);

    if (truncated.gap !== undefined) {
      gaps.push(truncated.gap);
    }

    return { url, author: authorName(comment.author), body: truncated.body };
  });

  return { reviews, comments, gaps };
};

export const parseInlineComments = (
  url: string,
  stdout: string,
): { comments: HistoryComment[]; gaps: HistoryGap[] } => {
  const label = `gh api inline comments for ${url}`;
  const value = parseJson(label, stdout);

  checkOutput(label, inlineCommentSchema, value);

  const gaps: HistoryGap[] = [];

  const comments = value.map((comment) => {
    const truncated = truncateBody(url, comment.body);

    if (truncated.gap !== undefined) {
      gaps.push(truncated.gap);
    }

    return { url, author: authorName(comment.user), body: truncated.body };
  });

  return { comments, gaps };
};
