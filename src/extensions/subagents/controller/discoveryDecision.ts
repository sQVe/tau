export type TaskRecordFact =
  | { kind: 'published'; taskId: string; parentSessionId: string }
  | { kind: 'unreadable' }
  | { kind: 'missing'; changedAt: number | undefined };

export type Discovery =
  | { kind: 'session'; parentSessionId: string }
  | { kind: 'ignored' }
  | { kind: 'pending'; changedAt: number }
  | { kind: 'abandoned' }
  | { kind: 'gone' };

export interface RootListing {
  change: number;
  at: number;
}

// File systems stamp a directory change with a coarse clock, so a change within this window of a
// listing may share the listed time.
export const stampMargin = 1000;

export const publicationWindow = 300_000;

export const retriesPending = (changedAt: number, now: number): boolean =>
  now - changedAt < publicationWindow;

export const discoverTask = (taskId: string, record: TaskRecordFact, now: number): Discovery => {
  if (record.kind === 'unreadable') {
    return { kind: 'ignored' };
  }

  if (record.kind === 'published') {
    return record.taskId === taskId
      ? { kind: 'session', parentSessionId: record.parentSessionId }
      : { kind: 'ignored' };
  }

  if (record.changedAt === undefined) {
    return { kind: 'gone' };
  }

  if (retriesPending(record.changedAt, now)) {
    return { kind: 'pending', changedAt: record.changedAt };
  }

  return { kind: 'abandoned' };
};

export const rootSettled = (
  listed: RootListing | undefined,
  change: number | undefined,
): boolean => {
  if (change === undefined || listed === undefined) {
    return false;
  }

  return listed.at - listed.change > stampMargin && change === listed.change;
};
