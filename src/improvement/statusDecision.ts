import type { EventGap, ImprovementEvent } from './event.ts';
import { decideStoredSignals } from './signals.ts';
import type { StoredSignals } from './signals.ts';
import type { SweepOutcome } from './sweep.ts';
import type { SweepIndexRead } from './sweepIndex.ts';

type MergeEvent = Extract<ImprovementEvent, { kind: 'merge' }>;

type FactsEvent = Extract<ImprovementEvent, { kind: 'facts' }>;

type SignalName = keyof StoredSignals;

export interface TaskToReview {
  pullRequest: string;
  mergedAt: string;
  signals: SignalName[];
}

export interface CoverageCounts {
  complete: number;
  managerOnly: number;
  missing: number;
}

export interface ImprovementStatus {
  projectRoot: string | null;
  tasks: TaskToReview[];
  correctDue: boolean;
  coverage: CoverageCounts;
  sweep: 'complete' | 'incomplete';
  gaps: EventGap[];
}

const correctPassIntervalMilliseconds = 604_800_000;

const reviewsForCorrectPass = 5;

const signalNames: readonly SignalName[] = ['reviewRounds', 'feedbackRounds', 'checkFailures'];

const isLater = (candidate: ImprovementEvent, current: ImprovementEvent): boolean => {
  const candidateTime = Date.parse(candidate.createdAt);
  const currentTime = Date.parse(current.createdAt);

  if (candidateTime !== currentTime) {
    return candidateTime > currentTime;
  }

  return candidate.id > current.id;
};

export const lastPassAt = (events: readonly ImprovementEvent[]): string | undefined => {
  const passes = events.filter((event) => event.kind === 'pass');

  const newest = passes.reduce<ImprovementEvent | undefined>(
    (current, event) => (current === undefined || isLater(event, current) ? event : current),
    undefined,
  );

  return newest?.createdAt;
};

const keepLatest = <Event extends MergeEvent | FactsEvent>(
  events: Map<string, Event>,
  event: Event,
): void => {
  const current = events.get(event.pullRequest);

  if (current === undefined || isLater(event, current)) {
    events.set(event.pullRequest, event);
  }
};

const compareTasks = (left: TaskToReview, right: TaskToReview): number => {
  const mergedTime = Date.parse(left.mergedAt) - Date.parse(right.mergedAt);

  if (mergedTime !== 0) {
    return mergedTime;
  }

  return left.pullRequest.localeCompare(right.pullRequest);
};

const groupEvents = (events: readonly ImprovementEvent[]) => {
  const merges = new Map<string, MergeEvent>();
  const facts = new Map<string, FactsEvent>();
  const reviewed = new Set<string>();

  for (const event of events) {
    if (event.kind === 'merge') {
      keepLatest(merges, event);
    } else if (event.kind === 'facts') {
      keepLatest(facts, event);
    } else if (event.kind === 'review') {
      reviewed.add(event.pullRequest);
    }
  }

  return { merges, facts, reviewed };
};

export const decideTasks = (
  events: readonly ImprovementEvent[],
): { tasks: TaskToReview[]; coverage: CoverageCounts } => {
  const { merges, facts, reviewed } = groupEvents(events);
  const coverage: CoverageCounts = { complete: 0, managerOnly: 0, missing: 0 };
  const tasks: TaskToReview[] = [];

  for (const [pullRequest, mergeEvent] of merges) {
    const factsEvent = facts.get(pullRequest);
    const factsCoverage = factsEvent?.coverage ?? 'missing';

    coverage[factsCoverage] += 1;

    if (factsEvent === undefined || reviewed.has(pullRequest)) {
      continue;
    }

    const stored = decideStoredSignals(factsEvent.facts);
    const signals = signalNames.filter((name) => stored[name] === 'fired');

    if (signals.length === 0) {
      continue;
    }

    tasks.push({ pullRequest, mergedAt: mergeEvent.mergedAt, signals });
  }

  tasks.sort(compareTasks);

  return { tasks, coverage };
};

const isNew = (event: ImprovementEvent, passAt: string | undefined): boolean =>
  passAt === undefined || Date.parse(event.createdAt) > Date.parse(passAt);

const isReviewOrCorrection = (event: ImprovementEvent): boolean =>
  event.kind === 'review' || event.kind === 'correction';

const isNewReviewOrCorrection = (event: ImprovementEvent, passAt: string | undefined): boolean =>
  isReviewOrCorrection(event) && isNew(event, passAt);

export const decideCorrectDue = (facts: {
  events: readonly ImprovementEvent[];
  lastPassAt: string | undefined;
  now: Date;
  readFailed: boolean;
}): boolean => {
  // A skipped event could be a review or correction, so a failed read is never "nothing due".
  if (facts.readFailed) {
    return true;
  }

  const newEvents = facts.events.filter((event) =>
    isNewReviewOrCorrection(event, facts.lastPassAt),
  );

  const newReviews = newEvents.filter((event) => event.kind === 'review').length;

  if (newReviews >= reviewsForCorrectPass) {
    return true;
  }

  if (newEvents.length === 0) {
    return false;
  }

  if (facts.lastPassAt === undefined) {
    return true;
  }

  return facts.now.getTime() - Date.parse(facts.lastPassAt) >= correctPassIntervalMilliseconds;
};

export const decideSweep = (facts: {
  index: SweepIndexRead;
  projectRoot: string | null;
  sessionSweep: SweepOutcome | undefined;
}): 'complete' | 'incomplete' => {
  if (facts.sessionSweep?.outcome === 'failed') {
    return 'incomplete';
  }

  if (facts.index.status !== 'read') {
    return 'incomplete';
  }

  const { lastSweep, projects } = facts.index.index;

  if (lastSweep?.outcome !== 'caughtUp') {
    return 'incomplete';
  }

  if (facts.projectRoot === null) {
    return 'complete';
  }

  const project = projects[facts.projectRoot];

  if (project?.merged.status === 'unknown') {
    return 'incomplete';
  }

  return 'complete';
};

export const statusText = (status: ImprovementStatus): string | undefined => {
  const parts: string[] = [];

  if (status.tasks.length > 0) {
    const noun = status.tasks.length === 1 ? 'task' : 'tasks';

    parts.push(`${status.tasks.length} ${noun} to review`);
  }

  if (status.correctDue) {
    parts.push('correct due');
  }

  if (status.sweep === 'incomplete') {
    parts.push('sweep incomplete');
  }

  return parts.length === 0 ? undefined : `improve: ${parts.join(' · ')}`;
};
