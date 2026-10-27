export interface WatchStartFacts {
  state: string;
  autoMergeEnabled: boolean;
}

// The bash exit status belongs to the last command in a list, so the pull request itself shows
// whether gh pr merge --auto took effect.
export const decideWatchStart = (facts: WatchStartFacts): boolean =>
  facts.autoMergeEnabled || facts.state === 'MERGED';
