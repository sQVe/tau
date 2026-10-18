import type { MutationStatus } from './mutationReport.js';

export interface MutationRunFacts {
  // undefined when the run never wrote a report.
  status: MutationStatus | undefined;
  // null when a signal ended the command.
  exitCode: number | null;
  idle: boolean;
}

// An idle stop or a signal leaves no report to trust.
export const runWasStopped = ({
  idle,
  exitCode,
}: Pick<MutationRunFacts, 'idle' | 'exitCode'>): boolean => idle || exitCode === null;

// The script exits 0 with survivors in audit mode, so the report status decides, and a nonzero
// exit never passes.
export const mutationPassed = (facts: MutationRunFacts): boolean => {
  if (runWasStopped(facts)) {
    return false;
  }

  const reportedPass = facts.status === 'pass' || facts.status === 'nothing';

  return reportedPass && facts.exitCode === 0;
};
