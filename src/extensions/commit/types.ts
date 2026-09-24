import { Type } from 'typebox';
import type { Static } from 'typebox';

export const reviewerFindingSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    line: Type.Integer({ minimum: 1 }),
    kind: Type.Union([Type.Literal('inaccurate'), Type.Literal('policy'), Type.Literal('missing')]),
    message: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

type ReviewerFinding = Static<typeof reviewerFindingSchema>;

export type CommentFinding =
  | ReviewerFinding
  | (Omit<ReviewerFinding, 'kind'> & { kind: 'unverified' });

export interface CommentReview {
  findings: CommentFinding[];
}

export interface CommitSuccess {
  details: {
    sha: string;
    files: string[];
    subject: string;
    body: string | null;
    message?: string;
    hooks?: 'run';
    hookChanges?: {
      files: string[];
      message: boolean;
    };
    commentReview?: {
      status: 'passed';
      tree: string;
      policy: string;
      report: string;
    };
  };
  content: {
    type: 'text';
    text: string;
  }[];
}

export interface ReviewState {
  key?: string;
  result?: CommentReview;
  returns: number;
  refusedTree?: string;
  disputes: { evidence: string; findings: string }[];
}

export type Reviews = Map<string, ReviewState>;

interface ReviewSnapshot {
  tree: string;
  head: string | null;
  dispute?: string;
}

export type RequestReview = (snapshot: ReviewSnapshot) => Promise<CommentReview>;
