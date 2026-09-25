import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../../errors/index.js';
import { readEvent, readReport } from './records.js';
import { requireNativeTask } from './types.js';
import type { Task } from './types.js';

interface Entry {
  directory: string;
  task: Task;
}

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

const sharesNativeSession = (entry: Entry, predecessor: Entry): boolean =>
  entry.task.nativeSessionId === predecessor.task.nativeSessionId &&
  entry.task.nativeSessionFile === predecessor.task.nativeSessionFile;

const hasMatchingChain = (entry: Entry, predecessor: Entry): boolean =>
  sharesNativeSession(entry, predecessor) &&
  isDeepStrictEqual(entry.task.loadout, predecessor.task.loadout);

const walkToOrigin = (entry: Entry, byId: Map<string, Entry>): Task => {
  let current = entry;
  const seen = new Set<string>();

  while (current.task.predecessorTaskId != null) {
    if (seen.has(current.task.taskId) || seen.size >= 1024) {
      throw new Error('Cyclic or excessive continuation chain.');
    }

    seen.add(current.task.taskId);
    const predecessor = byId.get(current.task.predecessorTaskId);

    if (!predecessor || !hasMatchingChain(current, predecessor)) {
      throw new Error('Missing or mismatched continuation chain.');
    }

    requireHandover(predecessor.directory, predecessor.task);
    current = predecessor;
  }

  return current.task;
};

export const continuationOrigins = (entries: Entry[]) => {
  const byId = new Map(entries.map((entry) => [entry.task.taskId, entry]));
  const origins = new Map<string, Task>();
  const diagnostics: string[] = [];

  for (const entry of entries) {
    try {
      origins.set(entry.task.taskId, walkToOrigin(entry, byId));
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

const liveSessionError = (paneId: string): Error =>
  new Error(`Native session is already live in pane ${paneId}. No follow-up start.`);

const matchesSessionId = (session: { value: string }, task: Task): boolean =>
  session.value === task.nativeSessionId || session.value === task.nativeSessionFile;

const resolveExistingPath = (value: string): string | undefined => {
  if (!isAbsolute(value)) {
    throw new Error('Cannot verify a relative live native session path.');
  }

  try {
    return realpathSync(value);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

const matchesSessionPath = (value: string, task: Task): boolean => {
  const path = resolveExistingPath(value);

  return path !== undefined && path === realpathSync(requireNativeTask(task).nativeSessionFile);
};

export const refuseLiveNativeWriter = (agents: unknown, task: Task): void => {
  if (!Value.Check(liveSessionsSchema, agents)) {
    throw new Error('Cannot verify live native writers: malformed herdr listing.');
  }

  for (const agent of agents) {
    const session = agent.agent_session;

    if (!session) {
      continue;
    }

    if (matchesSessionId(session, task)) {
      throw liveSessionError(agent.pane_id);
    }

    if (session.kind === 'path' && matchesSessionPath(session.value, task)) {
      throw liveSessionError(agent.pane_id);
    }
  }
};
