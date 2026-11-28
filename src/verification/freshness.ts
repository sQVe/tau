import type { RunRecord } from './records.js';

export type Freshness =
  | { fresh: true }
  | {
      fresh: false;
      reason:
        | 'notStopped'
        | 'stopFailed'
        | 'noIdentity'
        | 'treeChangedDuringRun'
        | 'treeChangedSinceRun'
        | 'doctorFailed';
    };

type FreshnessFacts = Pick<RunRecord, 'treeAtLaunch' | 'treeAtStop' | 'doctor' | 'stop'>;

const hasIdentity = (record: FreshnessFacts, currentTree: string | null): boolean =>
  record.treeAtLaunch !== null && record.treeAtStop !== null && currentTree !== null;

// A saved stop that did not exit 0 leaves the run open for a retry.
export const isStopped = (run: Pick<RunRecord, 'stop'>): boolean => run.stop?.exitCode === 0;

const doctorPassed = (record: FreshnessFacts): boolean => record.doctor?.exitCode === 0;

export const decideFreshness = (record: FreshnessFacts, currentTree: string | null): Freshness => {
  if (record.stop === null) {
    return { fresh: false, reason: 'notStopped' };
  }

  if (record.stop.exitCode !== 0) {
    return { fresh: false, reason: 'stopFailed' };
  }

  if (!hasIdentity(record, currentTree)) {
    return { fresh: false, reason: 'noIdentity' };
  }

  if (record.treeAtLaunch !== record.treeAtStop) {
    return { fresh: false, reason: 'treeChangedDuringRun' };
  }

  if (record.treeAtStop !== currentTree) {
    return { fresh: false, reason: 'treeChangedSinceRun' };
  }

  if (!doctorPassed(record)) {
    return { fresh: false, reason: 'doctorFailed' };
  }

  return { fresh: true };
};
