export interface OwnerFacts {
  foregroundPid: number | undefined;
  processGroup: number;
}

export interface OwnerNoticeFacts {
  terminal: string;
  foregroundPid: number | undefined;
}

const firstWaitMilliseconds = 500;
const secondWaitMilliseconds = 1_000;
const thirdWaitMilliseconds = 2_000;
const fourthWaitMilliseconds = 3_000;
const fifthWaitMilliseconds = 4_000;

const ownerWaitDelaysMilliseconds = [
  firstWaitMilliseconds,
  secondWaitMilliseconds,
  thirdWaitMilliseconds,
  fourthWaitMilliseconds,
  fifthWaitMilliseconds,
];

// hc reports the leader of the foreground process group. Pi's bash tool runs its shell detached, so
// a Pi started from it is in another group and never matches.
export const ownsTerminal = ({ foregroundPid, processGroup }: OwnerFacts): boolean =>
  foregroundPid === processGroup;

// A terminal can report no foreground process, or another one, while Pi starts, as a session in a
// background tab does. The wait covers that start. A Pi that never becomes the foreground process
// reports that it has no inbox instead of waiting forever.
export const ownerWaitDelay = (attempt: number): number | undefined =>
  ownerWaitDelaysMilliseconds[attempt];

export const noOwnerNotice = ({ terminal, foregroundPid }: OwnerNoticeFacts): string => {
  const foreground =
    foregroundPid === undefined
      ? `hc reports no foreground process for terminal ${terminal}`
      : `terminal ${terminal} reports pid ${String(foregroundPid)} in the foreground, not this Pi`;

  return `Tau inbox is off: ${foreground}, so no other session can send to this one. Start Pi as the terminal's foreground program to turn it on.`;
};
