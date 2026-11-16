import type { ImprovementEvent } from './event.ts';
import { decideStoredSignals } from './signals.ts';
import type { StoredSignals } from './signals.ts';
import type { SweepIndexRead } from './sweepIndex.ts';

export type SignalName = keyof StoredSignals;

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
  skipped: { path: string; notice: string }[];
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

const latest = (events: readonly ImprovementEvent[]): ImprovementEvent | undefined => {
  let found: ImprovementEvent | undefined;

  for (const event of events) {
    if (found === undefined || isLater(event, found)) {
      found = event;
    }
  }

  return found;
};

const addToGroup = (
  groups: Map<string, ImprovementEvent[]>,
  key: string,
  event: ImprovementEvent,
) => {
  const group = groups.get(key);

  if (group === undefined) {
    groups.set(key, [event]);
  } else {
    group.push(event);
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
  const merges = new Map<string, ImprovementEvent[]>();
  const facts = new Map<string, ImprovementEvent[]>();
  const reviewed = new Set<string>();

  for (const event of events) {
    if (!('pullRequest' in event)) {
      continue;
    }

    if (event.kind === 'merge') {
      addToGroup(merges, event.pullRequest, event);
    } else if (event.kind === 'facts') {
      addToGroup(facts, event.pullRequest, event);
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

  for (const [pullRequest, mergeEvents] of merges) {
    const mergeEvent = latest(mergeEvents);
    const factsEvent = latest(facts.get(pullRequest) ?? []);

    if (mergeEvent?.kind !== 'merge') {
      continue;
    }

    const factsCoverage = factsEvent?.kind === 'facts' ? factsEvent.coverage : 'missing';

    coverage[factsCoverage] += 1;

    if (factsEvent?.kind !== 'facts' || reviewed.has(pullRequest)) {
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

const isNew = (event: ImprovementEvent, lastPassAt: string | undefined): boolean =>
  lastPassAt === undefined || Date.parse(event.createdAt) > Date.parse(lastPassAt);

const isReviewOrCorrection = (event: ImprovementEvent): boolean =>
  event.kind === 'review' || event.kind === 'correction';

const isNewReviewOrCorrection = (
  event: ImprovementEvent,
  lastPassAt: string | undefined,
): boolean => isReviewOrCorrection(event) && isNew(event, lastPassAt);

export const decideCorrectDue = (facts: {
  events: readonly ImprovementEvent[];
  lastPassAt: string | undefined;
  now: Date;
}): boolean => {
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
}): 'complete' | 'incomplete' => {
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
