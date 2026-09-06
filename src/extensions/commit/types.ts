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
