import { isDeepStrictEqual } from 'node:util';

import { requireHandover } from '../continuations.js';
import { validateNative } from '../native.js';
import type { Visibility } from '../placement.js';
import { nativeIdentity } from '../profiles.js';
import { findSuccessor, mayFollow, readTask, readTasks } from '../records.js';
import type { UnreadableTask } from '../records.js';
import { isGenericLoadout } from '../types.js';
import type { Loadout, Task } from '../types.js';

export interface LaunchInput {
  task: string;
  label?: string;
  loadout: Loadout;
  timeout: number;
  parentSession: string;
  parentSessionId: string;
  parentPane?: string;
  visibility?: Visibility;
  startedAt?: { wall: number; monotonic: number };
}

export interface FollowUpPreparation {
  directory: string;
  task: Task;
  origin: Task;
  native: ReturnType<typeof validateNative>;
}

export const nativeReference = (
  loadout: Loadout,
  directory: string,
  source?: FollowUpPreparation,
) => {
  if (source) {
    return {
      predecessorTaskId: source.task.taskId,
      nativeSessionId: source.task.nativeSessionId,
      nativeSessionFile: source.task.nativeSessionFile,
    };
  }

  return isGenericLoadout(loadout) ? {} : nativeIdentity(directory);
};

export const requireUnclaimed = (root: string, source: { directory: string; task: Task }): void => {
  const diagnostics: string[] = [];
  const unreadable: UnreadableTask[] = [];
  const tasks = readTasks(root, diagnostics, [], unreadable);
  const successor = findSuccessor(tasks, source.task.taskId);

  if (successor) {
    throw new Error(
      `Task ${source.task.taskId} already has successor attempt ${successor.taskId}. No retry.`,
    );
  }

  for (const { directory, diagnostic } of unreadable) {
    if (mayFollow(directory, source.task.taskId)) {
      diagnostics.push(diagnostic);
    }
  }

  if (diagnostics.length) {
    throw new Error(`Cannot verify saved follow-up attempts: ${diagnostics.join(' ')}`);
  }

  requireHandover(source.directory, source.task);
};

export const checkHandoff = (source: FollowUpPreparation): void => {
  if (!isDeepStrictEqual(readTask(source.directory), source.task)) {
    throw new Error('Source task changed during follow-up validation.');
  }

  if (!isDeepStrictEqual(validateNative(source.task, source.origin), source.native)) {
    throw new Error('Native file changed during follow-up validation.');
  }
};
