export interface CommitSuccess {
  details: {
    sha: string;
    files: string[];
    subject: string;
    body: string | null;
    skipped?: true;
  };
  content: {
    type: 'text';
    text: string;
  }[];
}

export interface CommitFailure {
  hookFailed: boolean;
  stdout: string;
  stderr: string;
}
