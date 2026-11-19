export type StartPlan = 'release' | 'keep' | 'acquire';

export interface StartFacts {
  hasSessionFile: boolean;
  heldLockPath: string | undefined;
  lockPath: string | undefined;
}

export type ShutdownPlan = 'keep' | 'release';

export type ResumeHolderFact =
  | { read: 'failed' }
  | { read: 'ok'; holderPid: number | undefined; ownPid: number };

export type ResumePlan = 'allow' | 'refuse' | 'allow-with-warning';

// A start on the lock this process already holds keeps it. A start on another file frees the old
// lock before it takes the new one.
export const decideStart = (facts: StartFacts): StartPlan => {
  if (!facts.hasSessionFile) {
    return 'release';
  }

  if (facts.lockPath !== undefined && facts.lockPath === facts.heldLockPath) {
    return 'keep';
  }

  return 'acquire';
};

// A reload ends one session and starts the next on the same file in the same process.
export const decideShutdown = (reason: string): ShutdownPlan =>
  reason === 'reload' ? 'keep' : 'release';

// Only a resume with a target file needs the target's lock read.
export const needsResumeCheck = (reason: string, targetSessionFile: string | undefined): boolean =>
  reason === 'resume' && targetSessionFile !== undefined;

// A lock that cannot be read must not stop Pi.
export const decideResume = (fact: ResumeHolderFact): ResumePlan => {
  if (fact.read === 'failed') {
    return 'allow-with-warning';
  }

  if (fact.holderPid === undefined || fact.holderPid === fact.ownPid) {
    return 'allow';
  }

  return 'refuse';
};
