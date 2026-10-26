import { lstatSync, readdirSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { isMissingFile } from '../../errors.js';
import { isRecord } from '../../schema.js';
import { readEvent } from './records.js';
import { expiredWorkers, pastRetention } from './retentionDecision.js';
import type { SavedWorker } from './retentionDecision.js';
import { isTaskId } from './types.js';

interface TaskRecordRead {
  value: unknown;
  links: SavedWorker['links'];
}

const readTaskRecord = async (path: string): Promise<TaskRecordRead> => {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return { value: undefined, links: isMissingFile(error) ? 'known' : 'unreadable' };
  }

  try {
    return { value: JSON.parse(text), links: 'known' };
  } catch {
    return { value: undefined, links: 'malformed' };
  }
};

// Retention and the follow-up age limit both read this fact, so they agree on a task's age.
export const readLastWrite = (directory: string): number => {
  const paths = [directory, ...readdirSync(directory).map((entry) => join(directory, entry))];

  return Math.max(...paths.map((path) => lstatSync(path).mtimeMs));
};

const scanLastWrite = (directory: string): number | undefined => {
  try {
    return readLastWrite(directory);
  } catch {
    return undefined;
  }
};

const confirmsStop = (directory: string, taskId: string): boolean => {
  try {
    return readEvent(directory, taskId, 'cleanup')?.stopped === true;
  } catch {
    return false;
  }
};

const savedText = (task: unknown, key: string): string | undefined => {
  const value = isRecord(task) ? task[key] : undefined;

  return typeof value === 'string' ? value : undefined;
};

const savedWorker = async (
  root: string,
  taskId: string,
  sessionTaskIds: ReadonlySet<string>,
  now: number,
): Promise<SavedWorker> => {
  const directory = join(root, taskId);
  const record = await readTaskRecord(join(directory, 'task.json'));
  const stopped = confirmsStop(directory, taskId);
  const lastWrite = scanLastWrite(directory);
  const task = record.value;
  const vanishedRecord = lastWrite === undefined && task === undefined;
  const nativeSessionFile = savedText(task, 'nativeSessionFile');
  const nativeDirectory = nativeSessionFile === undefined ? undefined : dirname(nativeSessionFile);
  const nativeInRoot = nativeDirectory !== undefined && dirname(nativeDirectory) === root;

  return {
    taskId,
    lastWrite: lastWrite ?? now,
    stopped,
    currentSession: sessionTaskIds.has(taskId),
    predecessorTaskId: savedText(task, 'predecessorTaskId'),
    nativeSessionTaskId: nativeInRoot ? basename(nativeDirectory) : undefined,
    complete: lastWrite !== undefined,
    links: vanishedRecord ? 'unreadable' : record.links,
  };
};

const directoryNames = async (directory: string): Promise<string[]> => {
  try {
    const entries = await readdir(directory, { withFileTypes: true });

    return entries.flatMap((entry) => (entry.isDirectory() ? [entry.name] : []));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

const savedWorkers = async (
  root: string,
  sessionTaskIds: ReadonlySet<string>,
  now: number,
): Promise<SavedWorker[]> => {
  const workers: SavedWorker[] = [];
  const names = await directoryNames(root);

  for (const taskId of names.filter((name) => isTaskId(name))) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential reads bound open files.
    workers.push(await savedWorker(root, taskId, sessionTaskIds, now));
  }

  return workers;
};

export const deleteExpiredWorkers = async (
  root: string,
  sessionTaskIds: ReadonlySet<string>,
  now: number,
): Promise<string[]> => {
  const expired = expiredWorkers(await savedWorkers(root, sessionTaskIds, now), now);
  const deleted: string[] = [];

  for (const taskId of expired) {
    const lastWrite = scanLastWrite(join(root, taskId));

    if (lastWrite === undefined || !pastRetention(lastWrite, now)) {
      break;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- One deletion at a time keeps the disk load low.
    await rm(join(root, taskId), { recursive: true, force: true });
    deleted.push(taskId);
  }

  return deleted;
};
