import { decideFreshness, isStopped } from './freshness.js';
import type { Freshness } from './freshness.js';
import type { ItemRecord, RunRead } from './records.js';

export interface RecordProblem {
  run: string;
  item: string | null;
  problem: string;
}

export interface SelectedResult {
  target: string;
  item: string;
  run: string;
  freshness: Freshness;
  outcome: 'passed' | 'failed';
  counts: { passed: number; differs: number; blocked: number; notRun: number };
  record: ItemRecord;
}

interface Candidate {
  target: string;
  item: string;
  run: string;
  startedAt: number;
  freshness: Freshness;
  record: ItemRecord;
}

const isPassed = (record: ItemRecord): boolean =>
  record.steps.every((step) => step.status === 'passed') && record.endState.status === 'passed';

const countSteps = (record: ItemRecord): SelectedResult['counts'] => {
  const counts = { passed: 0, differs: 0, blocked: 0, notRun: 0 };

  for (const step of record.steps) {
    counts[step.status] += 1;
  }

  return counts;
};

const candidatesOf = (runs: readonly RunRead[], currentTree: string | null): Candidate[] =>
  runs.flatMap((run) => {
    if (run.read.status !== 'valid' || !isStopped(run.read.record)) {
      return [];
    }

    const record = run.read.record;
    const freshness = decideFreshness(record, currentTree);

    return run.items.flatMap((item) => {
      if (item.read.status !== 'valid') {
        return [];
      }

      return [
        {
          target: record.target,
          item: item.read.record.item,
          run: run.run,
          startedAt: Date.parse(record.startedAt),
          freshness,
          record: item.read.record,
        },
      ];
    });
  });

const isNewer = (candidate: Candidate, than: Candidate): boolean => {
  if (candidate.startedAt !== than.startedAt) {
    return candidate.startedAt > than.startedAt;
  }

  return candidate.run > than.run;
};

const selectNewest = (candidates: Candidate[]): Candidate => {
  const fresh = candidates.filter((candidate) => candidate.freshness.fresh);
  const pool = fresh.length > 0 ? fresh : candidates;

  return pool.reduce((newest, candidate) => (isNewer(candidate, newest) ? candidate : newest));
};

const groupKey = (candidate: Candidate): string => `${candidate.target}\u0000${candidate.item}`;

const compareCodePoints = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
};

const compareResults = (left: SelectedResult, right: SelectedResult): number => {
  const byTarget = compareCodePoints(left.target, right.target);

  return byTarget === 0 ? compareCodePoints(left.item, right.item) : byTarget;
};

export const listRecordProblems = (runs: readonly RunRead[]): RecordProblem[] =>
  runs.flatMap((run): RecordProblem[] => {
    if (run.read.status === 'malformed') {
      return [{ run: run.run, item: null, problem: run.read.problem }];
    }

    return run.items.flatMap((item): RecordProblem[] =>
      item.read.status === 'malformed'
        ? [{ run: run.run, item: item.item, problem: item.read.problem }]
        : [],
    );
  });

export const selectEvidence = (
  runs: readonly RunRead[],
  currentTree: string | null,
): SelectedResult[] => {
  const groups = new Map<string, Candidate[]>();

  for (const candidate of candidatesOf(runs, currentTree)) {
    const key = groupKey(candidate);
    const group = groups.get(key);

    if (group === undefined) {
      groups.set(key, [candidate]);
    } else {
      group.push(candidate);
    }
  }

  return [...groups.values()]
    .map(selectNewest)
    .map((candidate): SelectedResult => ({
      target: candidate.target,
      item: candidate.item,
      run: candidate.run,
      freshness: candidate.freshness,
      outcome: isPassed(candidate.record) ? 'passed' : 'failed',
      counts: countSteps(candidate.record),
      record: candidate.record,
    }))
    .toSorted(compareResults);
};
