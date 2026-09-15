export interface CommitSuccess {
  details: {
    sha: string;
    files: string[];
    subject: string;
    body: string | null;
    hooks?: 'run';
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
