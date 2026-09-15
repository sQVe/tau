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
