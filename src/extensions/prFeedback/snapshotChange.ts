// The pull request fields read returns, apart from mergeable.
export interface PullRequestSnapshot {
  number: number;
  url: string;
  author: string;
  headRefOid: string;
  state: string;
  baseRefName: string;
  headRefName: string;
  headRepository: string | null;
  headRepositoryOwner: string;
  isCrossRepository: boolean;
  maintainerCanModify: boolean;
}

export interface SnapshotChange {
  field: string;
  before: unknown;
  after: unknown;
}

const snapshotFields = [
  'number',
  'url',
  'author',
  'headRefOid',
  'state',
  'baseRefName',
  'headRefName',
  'headRepository',
  'headRepositoryOwner',
  'isCrossRepository',
  'maintainerCanModify',
] as const satisfies readonly (keyof PullRequestSnapshot)[];

// Returns the first field a reread changed, or undefined when the snapshots agree. Fields outside
// the snapshot, such as mergeable, never count.
export const snapshotChange = (
  first: PullRequestSnapshot,
  current: PullRequestSnapshot,
): SnapshotChange | undefined => {
  const field = snapshotFields.find((name) => first[name] !== current[name]);

  return field === undefined ? undefined : { field, before: first[field], after: current[field] };
};
