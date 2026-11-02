export type CommitContent = {
  type: 'text';
  text: string;
}[];

export interface CommittedGroupDetails {
  sha: string;
  files: string[];
  subject: string;
  body: string | null;
  message: string;
  hooks: 'run';
  hookChanges: {
    files: string[];
    message: boolean;
  };
}

export interface CommittedGroup {
  details: CommittedGroupDetails;
  content: CommitContent;
}
