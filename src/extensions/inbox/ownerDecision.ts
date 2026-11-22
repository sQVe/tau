export interface OwnerFacts {
  foregroundPid: number | undefined;
  processGroup: number;
}

// hc reports the leader of the foreground process group. Pi's bash tool runs its shell detached, so
// a Pi started from it is in another group and never matches.
export const ownsTerminal = ({ foregroundPid, processGroup }: OwnerFacts): boolean =>
  foregroundPid === processGroup;
