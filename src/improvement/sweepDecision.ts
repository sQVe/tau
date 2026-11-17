import type { ImprovementEvent } from './event.ts';
import type { Task } from './taskMapping.ts';

export type TranscriptRead = 'unchanged' | 'read' | 'restart';

export interface TranscriptReadFacts {
  cursor: number;
  size: number;
}

interface PlannedTask {
  task: Task;
  hash: string;
}

export interface PlannedEventFacts {
  tasks: readonly PlannedTask[];
  existingIds: ReadonlySet<string>;
  now: string;
}

export interface DiscoveryCandidate {
  path: string;
  status: 'new' | 'unresolved' | 'resolved';
}

export const decideTranscriptRead = ({ cursor, size }: TranscriptReadFacts): TranscriptRead => {
  if (size < cursor) {
    return 'restart';
  }

  return size === cursor ? 'unchanged' : 'read';
};

export const discoveryOrder = (candidates: readonly DiscoveryCandidate[]): string[] => {
  const unseen = candidates.filter(({ status }) => status === 'new').map(({ path }) => path);

  const retried = candidates
    .filter(({ status }) => status === 'unresolved')
    .map(({ path }) => path);

  return [...unseen, ...retried];
};

const numericFacts = (counts: Task['counts']): Record<string, number> => {
  const facts: Record<string, number> = {};

  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === 'number') {
      facts[key] = value;
    }
  }

  return facts;
};

const mergeEvent = (task: Task, hash: string, now: string): ImprovementEvent => ({
  version: 1,
  id: `merge-${hash}`,
  kind: 'merge',
  createdAt: now,
  evidence: [{ kind: 'pullRequest', url: task.pullRequest.url }],
  repository: task.pullRequest.repository,
  pullRequest: task.pullRequest.url,
  mergedAt: task.pullRequest.mergedAt,
});

const factsEvent = (task: Task, hash: string, now: string): ImprovementEvent | undefined => {
  if (task.coverage === 'unknown' || task.coverage === 'missing') {
    return undefined;
  }

  const publication = task.publication;

  const publicationEvidence =
    publication === undefined
      ? []
      : [
          {
            kind: 'transcript' as const,
            path: publication.path,
            toolCallId: publication.callId,
            entryId: publication.entryId,
          },
        ];

  return {
    version: 1,
    id: `facts-${hash}`,
    kind: 'facts',
    createdAt: now,
    evidence: [{ kind: 'pullRequest', url: task.pullRequest.url }, ...publicationEvidence],
    pullRequest: task.pullRequest.url,
    facts: numericFacts(task.counts),
    coverage: task.coverage,
  };
};

export const plannedEvents = ({ tasks, existingIds, now }: PlannedEventFacts): ImprovementEvent[] =>
  tasks.flatMap(({ task, hash }) => {
    const events = [mergeEvent(task, hash, now), factsEvent(task, hash, now)];

    return events.filter(
      (event): event is ImprovementEvent => event !== undefined && !existingIds.has(event.id),
    );
  });
