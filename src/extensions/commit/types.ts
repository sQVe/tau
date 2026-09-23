import type { CommentReview } from './commentReview.js';

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
