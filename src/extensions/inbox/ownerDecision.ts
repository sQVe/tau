export interface OwnerFacts {
  foregroundPid: number | undefined;
  processPid: number;
}

// A Pi started from another Pi's bash tool shares its terminal address but is not the foreground
// process. An ancestor rule would let that child match its parent.
export const ownsTerminal = ({ foregroundPid, processPid }: OwnerFacts): boolean =>
  foregroundPid === processPid;
