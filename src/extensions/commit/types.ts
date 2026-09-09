export interface CommitSuccess {
  details: {
    sha: string;
    files: string[];
    subject: string;
    body: string | null;
    skipped?: true;
    projectCheck?: string;
    commentReview?: {
      status: 'passed' | 'waived';
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
