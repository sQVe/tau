export interface SavedWorker {
  taskId: string;
  lastWrite: number;
  stopped: boolean;
  currentSession: boolean;
  predecessorTaskId: string | undefined;
  nativeSessionTaskId: string | undefined;
  complete: boolean;
  links: 'known' | 'malformed' | 'unreadable';
}

const millisecondsPerDay = 86_400_000;
const retentionDays = 14;

export const retentionMilliseconds = retentionDays * millisecondsPerDay;

// One day shorter than retention, so a deletion never removes a source that a follow-up accepted,
// unless the follow-up stalls more than a day before it publishes its task.
const followUpDays = retentionDays - 1;

export const followUpMilliseconds = followUpDays * millisecondsPerDay;

export const followUpRefusal = (sourceLastWrite: number, now: number): string | undefined => {
  if (now - sourceLastWrite <= followUpMilliseconds) {
    return undefined;
  }

  return `Follow-up refused: the source task was last written more than ${followUpDays} days ago, and stopped tasks are deleted after ${retentionDays} days. Start a fresh task instead.`;
};

export const pastRetention = (lastWrite: number, now: number): boolean =>
  now - lastWrite > retentionMilliseconds;

const expires = (worker: SavedWorker, now: number): boolean => {
  if (!worker.complete || worker.currentSession || worker.links === 'unreadable') {
    return false;
  }

  if (!worker.stopped && worker.links === 'known') {
    return false;
  }

  return pastRetention(worker.lastWrite, now);
};

const keptTaskIds = (workers: SavedWorker[], now: number): Set<string> => {
  const byTaskId = new Map(workers.map((worker) => [worker.taskId, worker]));
  const kept = new Set<string>();
  const pending = workers.filter((worker) => !expires(worker, now));

  for (let worker = pending.pop(); worker !== undefined; worker = pending.pop()) {
    kept.add(worker.taskId);

    for (const reference of [worker.predecessorTaskId, worker.nativeSessionTaskId]) {
      const referenced = reference === undefined ? undefined : byTaskId.get(reference);

      if (referenced !== undefined && !kept.has(referenced.taskId)) {
        pending.push(referenced);
      }
    }
  }

  return kept;
};

const blocksDeletion = (worker: SavedWorker, kept: ReadonlySet<string>, now: number): boolean => {
  if (!kept.has(worker.taskId) || worker.links === 'known') {
    return false;
  }

  return worker.links === 'unreadable' || !pastRetention(worker.lastWrite, now);
};

const references = (worker: SavedWorker): string[] =>
  [worker.predecessorTaskId, worker.nativeSessionTaskId].filter(
    (reference): reference is string => reference !== undefined && reference !== worker.taskId,
  );

const linkOrder = (expired: SavedWorker[]): string[] => {
  const pointedTo = new Map(expired.map((worker) => [worker.taskId, 0]));

  for (const reference of expired.flatMap(references)) {
    const count = pointedTo.get(reference);

    if (count !== undefined) {
      pointedTo.set(reference, count + 1);
    }
  }

  const byTaskId = new Map(expired.map((worker) => [worker.taskId, worker]));
  const ready = expired.filter((worker) => pointedTo.get(worker.taskId) === 0);
  const ordered: string[] = [];

  for (let worker = ready.shift(); worker !== undefined; worker = ready.shift()) {
    ordered.push(worker.taskId);

    for (const reference of references(worker)) {
      const count = pointedTo.get(reference);
      const referenced = byTaskId.get(reference);

      if (count === undefined || referenced === undefined) {
        continue;
      }

      pointedTo.set(reference, count - 1);

      if (count === 1) {
        ready.push(referenced);
      }
    }
  }

  return ordered;
};

export const expiredWorkers = (workers: SavedWorker[], now: number): string[] => {
  const kept = keptTaskIds(workers, now);
  const unknownLinks = workers.some((worker) => blocksDeletion(worker, kept, now));

  if (unknownLinks) {
    return [];
  }

  return linkOrder(workers.filter((worker) => !kept.has(worker.taskId)));
};
