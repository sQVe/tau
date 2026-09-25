import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { isMissingFile } from '../../errors/index.js';
import { continuationOrigins } from './continuations.js';
import { nativeHeader } from './native.js';
import { readTasks } from './records.js';
import { isGenericLoadout, requireNativeTask } from './types.js';
import type { Task } from './types.js';

export const canonical = (path: string): string => {
  if (!isAbsolute(path)) {
    throw new Error('Session lineage requires absolute paths.');
  }

  try {
    return realpathSync(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }

    return resolve(path);
  }
};

const readNode = (file: string) => {
  try {
    return { file, header: nativeHeader(file) };
  } catch (error) {
    throw new Error(`Session ancestry is unavailable: ${String(error)}`, { cause: error });
  }
};

export const lineage = (file: string, expectedId?: string) => {
  const nodes = [];
  const seen = new Set<string>();
  let next: string | undefined = file;

  while (next != null && next !== '') {
    const path = canonical(next);

    if (seen.has(path) || seen.size >= 1024) {
      throw new Error('Cyclic or excessive session ancestry.');
    }

    seen.add(path);
    const node = readNode(path);

    if (nodes.length === 0 && expectedId !== undefined && node.header.id !== expectedId) {
      throw new Error('Session lineage identity mismatch.');
    }

    nodes.push(node);
    next = node.header.parentSession;
  }

  return nodes;
};

export type LineageNode = ReturnType<typeof readNode>;

export const sameRoot = (left: LineageNode | undefined, right: LineageNode): boolean => {
  if (!left) {
    return false;
  }

  return left.file === right.file && left.header.id === right.header.id;
};

export const historyRegistry = (root: string) => {
  const scanDiagnostics: string[] = [];
  const entries = readTasks(root, scanDiagnostics);
  const { origins, diagnostics } = continuationOrigins(entries);

  diagnostics.push(...scanDiagnostics);
  const tasks = new Map<string, Task>();

  for (const origin of origins.values()) {
    if (isGenericLoadout(origin.loadout)) {
      continue;
    }

    const path = canonical(requireNativeTask(origin).nativeSessionFile);

    if (tasks.has(path) && tasks.get(path)?.taskId !== origin.taskId) {
      throw new Error('Conflicting saved native session identities.');
    }

    tasks.set(path, origin);
  }

  return {
    saved: entries.filter(({ task }) => origins.has(task.taskId)),
    origins,
    tasks,
    diagnostics,
  };
};
