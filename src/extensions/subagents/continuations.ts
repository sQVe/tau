import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { readEvent, readReport, readSuccessor } from './records.js';
import { requireNativeTask } from './types.js';
import type { Task } from './types.js';

export const requireHandover = (directory: string, task: Task): void => {
  if (!readReport(directory, task.taskId)) {
    throw new Error(`Task ${task.taskId} has no valid final handover. Follow-up refused.`);
  }

  if (readEvent(directory, task.taskId, 'cleanup')?.stopped !== true) {
    throw new Error(
      `Task ${task.taskId} has no confirmed parent cleanup. Worker settled or parent exit is insufficient.`,
    );
  }
};

export const continuationOrigins = (entries: { directory: string; task: Task }[]) => {
  const byId = new Map(entries.map((entry) => [entry.task.taskId, entry]));
  const origins = new Map<string, Task>();
  const diagnostics: string[] = [];

  for (const entry of entries) {
    try {
      let current = entry;
      const seen = new Set<string>();

      while (current.task.predecessorTaskId) {
        if (seen.has(current.task.taskId) || seen.size >= 1024) {
          throw new Error('Cyclic or excessive continuation chain.');
        }

        seen.add(current.task.taskId);
        const predecessor = byId.get(current.task.predecessorTaskId);

        if (
          !predecessor ||
          readSuccessor(predecessor.directory)?.successorTaskId !== current.task.taskId ||
          current.task.nativeSessionId !== predecessor.task.nativeSessionId ||
          current.task.nativeSessionFile !== predecessor.task.nativeSessionFile ||
          !isDeepStrictEqual(current.task.loadout, predecessor.task.loadout)
        ) {
          throw new Error('Unclaimed or mismatched continuation chain.');
        }

        requireHandover(predecessor.directory, predecessor.task);
        current = predecessor;
      }

      origins.set(entry.task.taskId, current.task);
    } catch (error) {
      diagnostics.push(`Task ${entry.task.taskId}: ${String(error)}`);
    }
  }

  return { origins, diagnostics };
};

const liveSessionsSchema = Type.Array(
  Type.Object({
    pane_id: Type.String({ minLength: 1 }),
    agent_session: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Object({
          kind: Type.Union([Type.Literal('id'), Type.Literal('path')]),
          value: Type.String({ minLength: 1 }),
        }),
      ]),
    ),
  }),
);

export const refuseLiveNativeWriter = (agents: unknown, task: Task): void => {
  if (!Value.Check(liveSessionsSchema, agents)) {
    throw new Error('Cannot verify live native writers: malformed herdr listing.');
  }

  for (const agent of agents) {
    const session = agent.agent_session;

    if (!session) {
      continue;
    }

    if (session.value === task.nativeSessionId || session.value === task.nativeSessionFile) {
      throw new Error(
        `Native session is already live in pane ${agent.pane_id}. No follow-up start.`,
      );
    }

    if (session.kind === 'path') {
      if (!isAbsolute(session.value)) {
        throw new Error('Cannot verify a relative live native session path.');
      }

      let path: string;

      try {
        path = realpathSync(session.value);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          continue;
        }

        throw error;
      }

      if (path === realpathSync(requireNativeTask(task).nativeSessionFile)) {
        throw new Error(
          `Native session is already live in pane ${agent.pane_id}. No follow-up start.`,
        );
      }
    }
  }
};
