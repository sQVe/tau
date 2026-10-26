import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isMissingFile } from '../../../errors.js';
import { readTask } from '../records.js';
import { isTaskId } from '../types.js';
import type { Task } from '../types.js';
import { discoverTask, retriesPending, rootSettled } from './discoveryDecision.js';
import type { RootListing, TaskRecordFact } from './discoveryDecision.js';

const listTaskNames = (root: string): string[] => {
  try {
    return readdirSync(root).filter((name) => isTaskId(name));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

const changedAt = (path: string): number | undefined =>
  statSync(path, { throwIfNoEntry: false })?.mtimeMs;

const readTaskRecord = (directory: string): TaskRecordFact => {
  try {
    const task = readTask(directory);

    return { kind: 'published', taskId: task.taskId, parentSessionId: task.parentSessionId };
  } catch (error) {
    if (isMissingFile(error)) {
      return { kind: 'missing', changedAt: changedAt(directory) };
    }

    return { kind: 'unreadable' };
  }
};

export class SessionTaskIndex {
  private readonly root: string;
  private readonly clock: () => number;
  private readonly classified = new Set<string>();
  private readonly pending = new Map<string, number>();
  private readonly abandoned = new Set<string>();
  private listed: RootListing | undefined;
  private readonly sessions = new Map<string, Set<string>>();

  constructor(root: string, clock: () => number = Date.now) {
    this.root = root;
    this.clock = clock;
  }

  add(parentSessionId: string, taskId: string): void {
    this.classified.add(taskId);
    this.identities(parentSessionId).add(taskId);
  }

  private identities(parentSessionId: string): Set<string> {
    const known = this.sessions.get(parentSessionId) ?? new Set<string>();

    this.sessions.set(parentSessionId, known);

    return known;
  }

  private classify(taskId: string, now: number): void {
    const discovery = discoverTask(taskId, readTaskRecord(join(this.root, taskId)), now);

    if (discovery.kind === 'pending') {
      this.pending.set(taskId, discovery.changedAt);

      return;
    }

    this.pending.delete(taskId);

    if (discovery.kind === 'abandoned') {
      this.abandoned.add(taskId);
    } else if (discovery.kind !== 'gone') {
      this.classified.add(taskId);
    }

    if (discovery.kind === 'session') {
      this.identities(discovery.parentSessionId).add(taskId);
    }
  }

  private retryPending(now: number): void {
    for (const [taskId, changed] of this.pending) {
      if (retriesPending(changed, now)) {
        this.classify(taskId, now);
      } else {
        this.pending.delete(taskId);
        this.abandoned.add(taskId);
      }
    }
  }

  private prune(names: ReadonlySet<string>): void {
    for (const taskId of [...this.classified, ...this.pending.keys(), ...this.abandoned]) {
      if (names.has(taskId)) {
        continue;
      }

      this.classified.delete(taskId);
      this.pending.delete(taskId);
      this.abandoned.delete(taskId);

      for (const identities of this.sessions.values()) {
        identities.delete(taskId);
      }
    }
  }

  private seen(taskId: string): boolean {
    return this.classified.has(taskId) || this.pending.has(taskId) || this.abandoned.has(taskId);
  }

  private refresh(): void {
    const change = changedAt(this.root);
    const now = this.clock();

    this.retryPending(now);

    if (rootSettled(this.listed, change)) {
      return;
    }

    this.listed = change === undefined ? undefined : { change, at: now };

    const names = new Set(listTaskNames(this.root));

    this.prune(names);

    for (const taskId of names) {
      if (!this.seen(taskId)) {
        this.classify(taskId, now);
      }
    }
  }

  taskIds(parentSessionId: string): ReadonlySet<string> {
    this.refresh();

    return this.identities(parentSessionId);
  }

  tasks(parentSessionId: string): { directory: string; task: Task }[] {
    return [...this.taskIds(parentSessionId)].flatMap((taskId) => {
      const directory = join(this.root, taskId);

      try {
        return [{ directory, task: readTask(directory) }];
      } catch {
        return [];
      }
    });
  }
}
