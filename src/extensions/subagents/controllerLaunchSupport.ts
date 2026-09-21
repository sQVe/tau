import { isDeepStrictEqual } from 'node:util';

import { requireHandover, refuseLiveNativeWriter } from './continuations.js';
import { authorizeHistoryTask } from './history.js';
import { validateNative } from './native.js';
import type { Visibility } from './placement.js';
import { nativeIdentity } from './profiles.js';
import { readSuccessor, readTask, readTasks } from './records.js';
import { result } from './terminal.js';
import { isGenericLoadout } from './types.js';
import type { Loadout, Task } from './types.js';

export interface LaunchInput {
  task: string;
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
  const claim = readSuccessor(source.directory);
  const pending = readTasks(root).find(({ task }) => task.predecessorTaskId === source.task.taskId);
  const successor = claim?.successorTaskId ?? pending?.task.taskId;

  if (successor) {
    throw new Error(
      `Task ${source.task.taskId} already has successor attempt ${successor}. No retry or age-based reclaim.`,
    );
  }

  requireHandover(source.directory, source.task);
};

export const checkHandoff = (root: string, source: FollowUpPreparation, successor: Task): void => {
  authorizeHistoryTask(
    root,
    { file: successor.parentSession, id: successor.parentSessionId },
    source.task.taskId,
  );

  if (
    !isDeepStrictEqual(readTask(source.directory), source.task) ||
    readSuccessor(source.directory)?.successorTaskId !== successor.taskId
  ) {
    throw new Error(`Successor ${successor.taskId} no longer owns its predecessor claim.`);
  }

  requireHandover(source.directory, source.task);

  if (!isDeepStrictEqual(validateNative(source.task, source.origin), source.native)) {
    throw new Error('Native file changed during follow-up validation. Claim retained; no retry.');
  }
};

export const checkNativeWriterListing = (response: string, task: Task): void => {
  const live = result(response);

  if (live.type !== 'agent_list') {
    throw new Error('Malformed live native writer listing.');
  }

  refuseLiveNativeWriter(live.agents, task);
};
