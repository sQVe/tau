// Spawn restrictions and child accounting adapted from pi-interactive-subagents c3e8b53. See LICENSE.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import {
  publish,
  readEvent,
  readRecord,
  readReport,
  readTask,
  readTasks,
  validateTask,
} from './records.js';
import { isPiLoadout } from './types.js';
import type { Loadout, Task } from './types.js';

type TreeIdentity = Pick<NonNullable<Task['tree']>, 'rootSession' | 'rootSessionId'>;

export const monotonicNow = (): number => Number(process.hrtime.bigint()) / 1_000_000;

export const endedKinds = [
  'cleanup',
  'cancelled',
  'timeout',
  'startupFailure',
  'parentClosed',
  'settled',
  'stopping',
] as const;

export const taskEnded = (directory: string, task: Task): boolean =>
  endedKinds.some((kind) => readEvent(directory, task.taskId, kind)) ||
  Boolean(readReport(directory, task.taskId));

export const inheritedInstructions = (parent: Task): string =>
  `${parent.loadout.instructions}\n\nParent-assigned scope (${parent.taskId}):\n${parent.task}\n\nChild role guidance within that scope:\n`;

export const assertInheritedLoadout = (parent: Task, child: Loadout): void => {
  const {
    profile: _parentProfile,
    role: _parentRole,
    instructions: _parentInstructions,
    ...settings
  } = parent.loadout;
  const { profile: _childProfile, role: _childRole, instructions, ...childSettings } = child;
  if (
    !isDeepStrictEqual(settings, childSettings) ||
    !instructions.startsWith(inheritedInstructions(parent))
  ) {
    throw new Error(
      'Nested work cannot change inherited settings or replace parent-assigned scope.',
    );
  }
};

export const admissionDirectory = (root: string, tree: TreeIdentity): string =>
  join(
    root,
    '.admission',
    createHash('sha256')
      .update(JSON.stringify([tree.rootSession, tree.rootSessionId]))
      .digest('hex'),
  );

const policySchema = Type.Object(
  {
    rootSession: Type.String({ minLength: 1 }),
    rootSessionId: Type.String({ minLength: 1 }),
    capacity: Type.Integer({ minimum: 1, maximum: 256 }),
  },
  { additionalProperties: false },
);

const sameTree = (left: TreeIdentity, right: TreeIdentity) =>
  left.rootSession === right.rootSession && left.rootSessionId === right.rootSessionId;

const readReservations = (directory: string, tree: TreeIdentity): Map<string, Task> => {
  const retained = new Map<string, Task>();
  for (const name of readdirSync(directory).filter(
    (candidate) => candidate.endsWith('.json') && candidate !== 'policy.json',
  )) {
    const reservation = validateTask(readRecord(directory, name));
    if (!sameTree(tree, reservation.tree) || name !== `${reservation.taskId}.json`) {
      throw new Error('Invalid saved capacity reservation. Manual inspection required.');
    }
    retained.set(reservation.taskId, reservation);
  }

  return retained;
};

export const descendantReservations = (root: string, task: Task): Task[] => {
  const reservations = readReservations(admissionDirectory(root, task.tree), task.tree);
  const byParent = new Map<string, Task[]>();
  for (const reservation of reservations.values()) {
    const parentTaskId = reservation.tree.parentTaskId;
    if (parentTaskId) {
      byParent.set(parentTaskId, [...(byParent.get(parentTaskId) ?? []), reservation]);
    }
  }
  const pending = [task.taskId];
  const descendants: Task[] = [];
  const seen = new Set<string>();
  while (pending.length) {
    const parent = pending.pop();
    if (parent === undefined) {
      break;
    }
    if (seen.has(parent)) {
      throw new Error('Cyclic reservation ancestry. Manual inspection required.');
    }
    seen.add(parent);
    const children = byParent.get(parent) ?? [];
    descendants.push(...children);
    pending.push(...children.map((child) => child.taskId));
  }

  return descendants;
};

const retainedReservations = (root: string, directory: string, tree: TreeIdentity): Task[] => {
  const retained = readReservations(directory, tree);
  for (const saved of readTasks(root)) {
    const savedTree = saved.task.tree;
    if (sameTree(tree, savedTree)) {
      const reservation = retained.get(saved.task.taskId);
      if (reservation && !isDeepStrictEqual(reservation, saved.task)) {
        throw new Error('Task differs from its reservation. Manual inspection required.');
      }
      retained.set(saved.task.taskId, saved.task);
    }
  }

  return [...retained.values()];
};

export const requireActiveAncestry = (root: string, task: Task): void => {
  const tree = task.tree;
  const seen = new Set<string>();
  let current: Task | undefined = task;
  while (current) {
    if (
      !sameTree(tree, current.tree) ||
      seen.has(current.taskId) ||
      seen.size >= 1024 ||
      taskEnded(join(root, current.taskId), current)
    ) {
      throw new Error('Nested work has inactive or invalid parent ancestry.');
    }
    seen.add(current.taskId);
    current = current.tree.parentTaskId
      ? readTask(join(root, current.tree.parentTaskId))
      : undefined;
  }
};

const admissionPolicy = (directory: string, tree: NonNullable<Task['tree']>, capacity: number) => {
  const policySaved = existsSync(join(directory, 'policy.json'));
  let configured: unknown = {
    rootSession: tree.rootSession,
    rootSessionId: tree.rootSessionId,
    capacity,
  };
  if (policySaved) {
    try {
      configured = readRecord(directory, 'policy.json');
    } catch (error) {
      throw new Error(`Invalid saved root admission policy at ${directory}.`, { cause: error });
    }
  }
  if (!Value.Check(policySchema, configured) || !sameTree(tree, configured)) {
    throw new Error(
      policySaved
        ? `Invalid saved root admission policy at ${directory}.`
        : 'Invalid initial root capacity: TAU_SUBAGENT_CAP must be an integer from 1 to 256.',
    );
  }
  if (!policySaved) {
    if (tree.parentTaskId) {
      throw new Error('A descendant cannot configure root capacity.');
    }
    publish(directory, 'policy.json', configured);
  }

  return configured;
};

const validateChildReservation = (
  root: string,
  task: Task,
  tree: NonNullable<Task['tree']>,
): void => {
  if (!tree.parentTaskId) {
    return;
  }
  const parent = readTask(join(root, tree.parentTaskId));
  if (
    !isPiLoadout(parent.loadout) ||
    !isPiLoadout(task.loadout) ||
    !sameTree(tree, parent.tree) ||
    task.parentSession !== parent.nativeSessionFile ||
    task.parentSessionId !== parent.nativeSessionId ||
    tree.monotonicDeadline > parent.tree.monotonicDeadline - parent.cancellationBudget
  ) {
    throw new Error(
      'Nested reservation has invalid active lineage or exceeds its parent deadline.',
    );
  }
  requireActiveAncestry(root, parent);
  assertInheritedLoadout(parent, task.loadout);
};

// Immutable reservations are never recycled. Only a matching parent cleanup receipt makes a slot free.
export const reserveTask = (root: string, value: Task, capacity = 4): void => {
  const task = validateTask(value);
  const tree = task.tree;
  const directory = admissionDirectory(root, tree);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'lock');
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `Admission busy. No queue or automatic lock reclaim. Inspect ${lock} manually; stop this tree's controllers before removing an abandoned lock.`,
        { cause: error },
      );
    }
    throw error;
  }

  let released = false;
  let releaseFailure: unknown;

  // No awaits or harness calls inside this transaction. Crashed locks require manual inspection, never age-based reclaim.
  try {
    const configured = admissionPolicy(directory, tree, capacity);
    if (
      existsSync(join(directory, `${task.taskId}.json`)) ||
      existsSync(join(root, task.taskId, 'task.json'))
    ) {
      throw new Error(`Task ${task.taskId} is already reserved or saved. No duplicate admission.`);
    }
    const retained = retainedReservations(root, directory, tree);
    const live = retained.filter(
      (saved) => readEvent(join(root, saved.taskId), saved.taskId, 'cleanup')?.stopped !== true,
    );
    if (live.length >= configured.capacity) {
      const evidence = live
        .slice(0, 10)
        .map((saved) => `${saved.taskId}: ${join(root, saved.taskId)}`)
        .join('; ');
      throw new Error(
        `Worker capacity full (${live.length}/${configured.capacity}). No queue. Waiting and uncertain work retain slots. Reservations: ${directory}. Inspect task/cleanup evidence before manual cleanup: ${evidence}.`,
      );
    }
    validateChildReservation(root, task, tree);
    try {
      publish(directory, `${task.taskId}.json`, task);
    } catch (error) {
      throw new Error(
        `Reservation ${task.taskId} publication is uncertain at ${directory}. Capacity may remain held. Inspect manually; no automatic retry.`,
        { cause: error },
      );
    }
  } finally {
    // A failed release must not replace the refusal that caused it.
    try {
      rmdirSync(lock);
      released = true;
    } catch (error) {
      releaseFailure = error;
    }
  }
  if (!released) {
    throw new Error(
      `Admission lock ${lock} was not released. The reservation stands; remove the lock manually before the next launch.`,
      { cause: releaseFailure },
    );
  }
};
