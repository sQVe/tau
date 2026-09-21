import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { monotonicNow, requireActiveAncestry, taskEnded } from './admission.js';
import { runClient } from './cancellation.js';
import { readEvent, readRecord, readTasks } from './records.js';
import { sessionLineage } from './sessionLineage.js';
import { isPiLoadout } from './types.js';
import type { Task } from './types.js';

export const currentProcessIdentity = async (signal?: AbortSignal) => {
  const output = await runClient('ps', ['-p', String(process.pid), '-o', 'lstart='], 1000, {
    signal,
  });
  const startedAt = output.trim();

  if (!startedAt) {
    throw new Error('Current process start identity is unavailable.');
  }

  return { processId: process.pid, startedAt };
};

const ownedSchema = Type.Object({
  processId: Type.Integer({ minimum: 1 }),
  startedAt: Type.String({ minLength: 1 }),
  token: Type.Optional(Type.String({ minLength: 1 })),
});

interface OwnedRecord {
  processId: number;
  startedAt: string;
  token?: string;
}

interface ProcessIdentity {
  processId: number;
  startedAt: string;
}

const ownedRecord = (value: unknown): OwnedRecord | undefined => {
  if (!Value.Check(ownedSchema, value)) {
    return undefined;
  }

  return value;
};

const matchesOwnedProcess = (owned: OwnedRecord, processIdentity: ProcessIdentity): boolean =>
  owned.processId === processIdentity.processId && owned.startedAt === processIdentity.startedAt;

const matchesOwnedWorker = (
  owned: OwnedRecord,
  current: { file: string; id: string },
  processIdentity: ProcessIdentity,
): boolean => matchesOwnedProcess(owned, processIdentity) && owned.token === current.file;

const readOwnedRecord = (directory: string): unknown => {
  try {
    return readRecord(directory, 'owned.json');
  } catch {
    return undefined;
  }
};

const matchesOwnedSession = (
  directory: string,
  task: Task,
  current: { file: string; id: string },
  processIdentity: ProcessIdentity,
): boolean => {
  if (taskEnded(directory, task) || !existsSync(join(directory, 'owned.json'))) {
    return false;
  }

  const owned = ownedRecord(readOwnedRecord(directory));

  if (!owned || !matchesOwnedWorker(owned, current, processIdentity)) {
    return false;
  }

  const ready = readEvent(directory, task.taskId, 'ready');
  const accepted = Boolean(readEvent(directory, task.taskId, 'accepted'));
  const matchesNativeSession =
    task.nativeSessionId === current.id && task.nativeSessionFile === current.file;

  return matchesNativeSession && ready?.processId === processIdentity.processId && accepted;
};

const locatorMatches = (locator: string | undefined, directory: string): boolean => {
  if (!locator) {
    return true;
  }

  return existsSync(locator) && realpathSync(locator) === realpathSync(directory);
};

const matchesRootSession = (task: Task, ancestry: ReturnType<typeof sessionLineage>): boolean =>
  task.tree.rootSession === ancestry.root.rootSession &&
  task.tree.rootSessionId === ancestry.root.rootSessionId;

const hasDelegationAuthority = (task: Task): boolean =>
  isPiLoadout(task.loadout) && task.loadout.tools.includes('subagent');

const deadlineHasBudgetLeft = (task: Task): boolean =>
  monotonicNow() < task.tree.monotonicDeadline - task.cancellationBudget;

const parentAuthorityIsValid = (
  task: Task,
  ancestry: ReturnType<typeof sessionLineage>,
  locator: string | undefined,
  directory: string,
): boolean => {
  if (!locatorMatches(locator, directory)) {
    return false;
  }

  if (!matchesRootSession(task, ancestry)) {
    return false;
  }

  return hasDelegationAuthority(task) && deadlineHasBudgetLeft(task);
};

const refuseWorkerProcessAsRoot = (
  directories: string[],
  processIdentity: ProcessIdentity,
): void => {
  // Removing the locator or switching native sessions cannot turn an owned worker into a root caller.
  // Retired records are included because a worker launched before an upgrade may still be running.
  for (const directory of directories) {
    if (!existsSync(join(directory, 'owned.json'))) {
      continue;
    }

    let owned: unknown;

    try {
      owned = readRecord(directory, 'owned.json');
    } catch (error) {
      // An unreadable record may belong to this very process.
      throw new Error(
        `Worker ownership record at ${directory} is unreadable, so root identity cannot be granted. Inspect it manually.`,
        { cause: error },
      );
    }

    const record = ownedRecord(owned);

    if (record && matchesOwnedProcess(record, processIdentity)) {
      throw new Error('Owned worker process cannot claim a different root identity.');
    }
  }
};

// Pi supplies session and process evidence. Tool arguments and environment identity strings cannot replace it.
export const authenticateParent = (
  root: string,
  current: { file: string; id: string },
  processIdentity: ProcessIdentity,
  locator?: string,
): { tree: NonNullable<Task['tree']>; parent?: Task } => {
  const ancestry = sessionLineage(root, current);
  const retired: string[] = [];
  const entries = readTasks(root, [], retired);
  const candidates = entries.filter(
    ({ task }) => task.nativeSessionId === current.id || task.nativeSessionFile === current.file,
  );
  const matches = candidates.filter(({ directory, task }) =>
    matchesOwnedSession(directory, task, current, processIdentity),
  );
  const selected = matches.length === 1 ? matches[0] : undefined;

  if (selected) {
    const { task, directory } = selected;

    if (!parentAuthorityIsValid(task, ancestry, locator, directory)) {
      throw new Error(
        'Nested parent authority, locator, or original deadline is invalid. Saved workers cannot acquire new delegation authority.',
      );
    }

    requireActiveAncestry(root, task);

    return { tree: { ...task.tree, parentTaskId: task.taskId }, parent: task };
  }

  if (locator || candidates.length || ancestry.hasWorkerAncestor) {
    throw new Error('Worker native session or parent-owned process identity does not match.');
  }

  refuseWorkerProcessAsRoot(
    [...entries.map(({ directory }) => directory), ...retired],
    processIdentity,
  );

  return { tree: { ...ancestry.root, monotonicDeadline: Number.MAX_SAFE_INTEGER } };
};
