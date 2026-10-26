// Decides how the session task index treats each task directory, from facts the caller read.
// tests/structure.test.ts keeps this module pure.

export type TaskRecordFact =
  | { kind: 'published'; taskId: string; parentSessionId: string }
  | { kind: 'unreadable' }
  // The directory has no task record; changedAt is undefined when the directory is gone too.
  | { kind: 'missing'; changedAt: number | undefined };

export type Discovery =
  | { kind: 'session'; parentSessionId: string }
  // Never read again: a record that cannot be read or that names another task.
  | { kind: 'ignored' }
  // Read again on each refresh until its record appears or the publication window passes.
  | { kind: 'pending'; changedAt: number }
  // Never read again, unless the directory vanishes and a new one takes its name.
  | { kind: 'abandoned' }
  | { kind: 'gone' };

export interface RootListing {
  change: number;
  at: number;
}

// File systems stamp a directory change with a coarse clock, so a change within this window of a
// listing may share the listed time.
export const stampMargin = 1000;

// A launch publishes its task record right after it creates the directory. A directory still without
// one after five minutes counts as abandoned.
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

// A missing root never counts as settled, so its return is listed again.
export const rootSettled = (
  listed: RootListing | undefined,
  change: number | undefined,
): boolean => {
  if (change === undefined || listed === undefined) {
    return false;
  }

  return listed.at - listed.change > stampMargin && change === listed.change;
};
