export interface CommitSuccess {
  details: {
    sha: string;
    files: string[];
    pathBase?: 'repository';
    preparationAddedFiles?: string[];
    subject: string;
    body: string | null;
    projectCheck?: string;
    messageCheck?: string;
    hooks?: 'run' | 'skip';
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
