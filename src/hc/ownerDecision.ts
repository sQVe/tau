export interface OwnerFacts {
  foregroundPid: number | undefined;
  processGroup: number;
  elapsedMilliseconds: number;
  deadlineMilliseconds: number;
}

export type OwnerVerdict = 'owner' | 'notOwner' | 'wait' | 'noForeground';

// hc reports the leader of the foreground process group. Pi's bash tool runs its shell detached, so
// a Pi started from it is in another group and never matches.
export const decideOwner = ({
  foregroundPid,
  processGroup,
  elapsedMilliseconds,
  deadlineMilliseconds,
}: OwnerFacts): OwnerVerdict => {
  if (foregroundPid === processGroup) {
    return 'owner';
  }

  if (foregroundPid !== undefined) {
    return 'notOwner';
  }

  return elapsedMilliseconds < deadlineMilliseconds ? 'wait' : 'noForeground';
};
