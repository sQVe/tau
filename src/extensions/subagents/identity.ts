import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { monotonicNow, requireActiveAncestry, taskEnded } from './admission.js';
import { runClient } from './cancellation.js';
import { sessionLineage } from './history.js';
import { readEvent, readRecord, readTasks } from './records.js';
import type { Task } from './types.js';

export const currentProcessIdentity = async (signal?: AbortSignal) => {
  const output = await runClient('ps', ['-p', String(process.pid), '-o', 'lstart='], 1000, signal);
  const startedAt = output.trim();
  if (!startedAt) {
    throw new Error('Current process start identity is unavailable.');
  }

  return { processId: process.pid, startedAt };
};

const ownedSchema = Type.Object({
  processId: Type.Integer({ minimum: 1 }),
  startedAt: Type.String({ minLength: 1 }),
  token: Type.String({ minLength: 1 }),
});

const refuseWorkerProcessAsRoot = (
  entries: ReturnType<typeof readTasks>,
  processIdentity: { processId: number; startedAt: string },
): void => {
  // Removing the locator or switching native sessions cannot turn an owned worker into a root caller.
  for (const { directory } of entries) {
    if (!existsSync(join(directory, 'owned.json'))) {
      continue;
    }
    const owned = readRecord(directory, 'owned.json');
    if (
      Value.Check(ownedSchema, owned) &&
      owned.processId === processIdentity.processId &&
      owned.startedAt === processIdentity.startedAt
    ) {
      throw new Error('Owned worker process cannot claim a different root identity.');
    }
  }
};

// Pi supplies session and process evidence. Tool arguments and environment identity strings cannot replace it.
export const authenticateParent = (
  root: string,
  current: { file: string; id: string },
  processIdentity: { processId: number; startedAt: string },
  locator?: string,
): { tree: NonNullable<Task['tree']>; parent?: Task } => {
  const ancestry = sessionLineage(root, current);
  const entries = readTasks(root);
  const candidates = entries.filter(
    ({ task }) => task.nativeSessionId === current.id || task.nativeSessionFile === current.file,
  );
  const matches = candidates.filter(({ directory, task }) => {
    if (taskEnded(directory, task) || !existsSync(join(directory, 'owned.json'))) {
      return false;
    }
    const owned = readRecord(directory, 'owned.json');

    return (
      Value.Check(ownedSchema, owned) &&
      owned.processId === processIdentity.processId &&
      owned.startedAt === processIdentity.startedAt &&
      owned.token === current.file &&
      task.nativeSessionId === current.id &&
      task.nativeSessionFile === current.file &&
      readEvent(directory, task.taskId, 'ready')?.processId === processIdentity.processId &&
      Boolean(readEvent(directory, task.taskId, 'accepted'))
    );
  });
  const selected = matches.length === 1 ? matches[0] : undefined;
  if (selected) {
    const { task, directory } = selected;
    if (
      (locator && (!existsSync(locator) || realpathSync(locator) !== realpathSync(directory))) ||
      !task.tree ||
      task.tree.rootSession !== ancestry.root.rootSession ||
      task.tree.rootSessionId !== ancestry.root.rootSessionId ||
      !task.loadout.tools.includes('subagent') ||
      monotonicNow() >= task.tree.monotonicDeadline - task.cancellationBudget
    ) {
      throw new Error(
        'Nested parent authority, locator, or original deadline is invalid. Legacy workers cannot acquire new delegation authority.',
      );
    }

    requireActiveAncestry(root, task);

    return { tree: { ...task.tree, parentTaskId: task.taskId }, parent: task };
  }
  if (locator || candidates.length || ancestry.hasWorkerAncestor) {
    throw new Error('Worker native session or parent-owned process identity does not match.');
  }
  refuseWorkerProcessAsRoot(entries, processIdentity);

  return { tree: { ...ancestry.root, monotonicDeadline: Number.MAX_SAFE_INTEGER } };
};
