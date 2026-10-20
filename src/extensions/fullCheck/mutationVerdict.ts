import type { MutationStatus } from './mutationReport.js';

export interface MutationRunFacts {
  // undefined when the run never wrote a report.
  status: MutationStatus | undefined;
  // null when a signal ended the command.
  exitCode: number | null;
  idle: boolean;
  hasUnmutated: boolean;
}

// An idle stop or a signal leaves no report to trust.
export const runWasStopped = ({
  idle,
  exitCode,
}: Pick<MutationRunFacts, 'idle' | 'exitCode'>): boolean => idle || exitCode === null;

// Survivors are advice: the script exits 2 with them in changed mode and 0 in audit mode. Any
// other exit with survivors, an error report, a missing report, or unmutated files fails.
export const mutationPassed = (facts: MutationRunFacts): boolean => {
  if (runWasStopped(facts) || facts.hasUnmutated) {
    return false;
  }

  const reportedPass = facts.status === 'pass' || facts.status === 'nothing';

  if (reportedPass) {
    return facts.exitCode === 0;
  }

  const survivorExit = facts.exitCode === 0 || facts.exitCode === 2;

  return facts.status === 'survivors' && survivorExit;
};
