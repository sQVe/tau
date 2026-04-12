export interface CommitSuccess {
  details: {
    sha: string;
    files: string[];
    subject: string;
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
