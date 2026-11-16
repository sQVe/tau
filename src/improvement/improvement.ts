import { open, readdir, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { errorMessage, isMissingFile } from '../errors.ts';
import { newerFormatNotice } from '../record.ts';
import { combinedReadability } from './taskMapping.ts';
import type { WorkerTranscript } from './taskMapping.ts';
import { parseTranscript } from './transcript.ts';
import type { Transcript } from './transcript.ts';
import {
  currentAssignmentVersion,
  ownsSession,
  parseAssignment,
  parseWorkerTask,
} from './workerRecord.ts';
import type { WorkerTask } from './workerRecord.ts';

interface SessionFiles {
  managerSessions: string[];
  workerSessions: string[];
  workerRecords: string[];
}

interface WorkerRecord {
  task: WorkerTask;
  directory: string;
}

export type WorkerRecordRead =
  | { status: 'read'; record: WorkerRecord }
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'newer'; notice: string }
  | { status: 'unreadable'; reason: string };

export type TranscriptChunk =
  | { status: 'read'; text: string; nextOffset: number; size: number }
  | { status: 'missing' }
  | { status: 'unreadable'; reason: string };

const listFiles = async (directory: string) => {
  try {
    const names = await readdir(directory, { recursive: true, encoding: 'utf8' });

    return names.map((name) => join(directory, name));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

const isSession = (path: string) => path.endsWith('.jsonl');

const isInWorkerDirectory = (path: string) =>
  ['assignments', 'workers'].includes(basename(dirname(dirname(path))));

const isWorkerSession = (path: string) => isSession(path) && isInWorkerDirectory(path);

const isWorkerRecord = (path: string) =>
  ['assignment.json', 'task.json'].includes(basename(path)) && isInWorkerDirectory(path);

export const findSessionFiles = async (agentDirectory: string): Promise<SessionFiles> => {
  const managerFiles = await listFiles(join(agentDirectory, 'sessions'));
  const workerFiles = await listFiles(join(agentDirectory, 'tau'));

  return {
    managerSessions: managerFiles.filter(isSession),
    workerSessions: workerFiles.filter(isWorkerSession),
    workerRecords: workerFiles.filter(isWorkerRecord),
  };
};

export const readWorkerRecord = async (path: string): Promise<WorkerRecordRead> => {
  let source: string;

  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    return isMissingFile(error)
      ? { status: 'missing' }
      : { status: 'unreadable', reason: errorMessage(error) };
  }

  const isAssignment = basename(path) === 'assignment.json';
  const task = isAssignment ? parseAssignment(source) : parseWorkerTask(source);

  if (task !== undefined) {
    return { status: 'read', record: { task, directory: dirname(path) } };
  }

  const notice = isAssignment
    ? newerFormatNotice(path, source, {
        label: 'assignment record',
        version: currentAssignmentVersion,
      })
    : undefined;

  return notice === undefined ? { status: 'malformed' } : { status: 'newer', notice };
};

export const readTranscript = async (path: string): Promise<Transcript> => {
  let source: string;

  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return parseTranscript(undefined);
    }

    return { status: 'unreadable', reason: errorMessage(error) };
  }

  return parseTranscript(source);
};

const readability = (transcript: Transcript): WorkerTranscript => {
  if (transcript.status === 'read') {
    return 'readable';
  }

  return transcript.status === 'missing' ? 'missing' : 'unreadable';
};

const readSessions = async (paths: readonly string[]) => {
  const results: WorkerTranscript[] = [];

  for (const path of paths) {
    // oxlint-disable-next-line no-await-in-loop -- Reads started together would open too many files.
    results.push(readability(await readTranscript(path)));
  }

  return results;
};

export const readWorkerTranscripts = async (
  agentDirectory: string,
  taskIds: ReadonlySet<string>,
): Promise<Map<string, WorkerTranscript>> => {
  const { workerRecords, workerSessions } = await findSessionFiles(agentDirectory);
  const workers = new Map<string, WorkerTranscript>();

  for (const recordPath of workerRecords) {
    // oxlint-disable-next-line no-await-in-loop -- Reads started together would open too many files.
    const read = await readWorkerRecord(recordPath);
    const directoryName = basename(dirname(recordPath));
    const taskId = read.status === 'read' ? read.record.task.taskId : undefined;
    const namesTask = taskId !== undefined && taskIds.has(taskId);
    const isWanted = taskIds.has(directoryName) || namesTask;

    if (!isWanted) {
      continue;
    }

    if (read.status !== 'read' && read.status !== 'missing') {
      workers.set(directoryName, 'unreadable');
    }

    if (read.status !== 'read') {
      continue;
    }

    const { record } = read;

    const sessions = workerSessions.filter((path) =>
      ownsSession(record.task, record.directory, path),
    );

    // oxlint-disable-next-line no-await-in-loop -- Reads started together would open too many files.
    const results = await readSessions(sessions);

    workers.set(record.task.taskId, combinedReadability(results));
  }

  return workers;
};

const newlineByte = 0x0a;

// oxlint-disable-next-line no-magic-numbers -- A 64 KiB read keeps short reads rare without allocating much.
const readChunkSize = 64 * 1024;

const parseChunkArguments = (offset: number, byteLimit: number) => {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError('offset must be a non-negative integer.');
  }

  if (!Number.isInteger(byteLimit) || byteLimit < 1) {
    throw new RangeError('byteLimit must be an integer of at least 1.');
  }
};

const readBytes = async (handle: FileHandle, position: number, length: number) => {
  const buffer = Buffer.alloc(length);
  let filled = 0;

  while (filled < length) {
    // oxlint-disable-next-line no-await-in-loop -- A short read must finish before the next read starts.
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);

    if (bytesRead === 0) {
      break;
    }

    filled += bytesRead;
  }

  return buffer.subarray(0, filled);
};

const readToNewline = async (
  handle: FileHandle,
  first: Buffer,
  offset: number,
  size: number,
): Promise<{ text: string; nextOffset: number }> => {
  const parts = [first];
  let position = offset + first.length;

  while (position < size) {
    // oxlint-disable-next-line no-await-in-loop -- Each read starts where the previous one ended.
    const chunk = await readBytes(handle, position, Math.min(readChunkSize, size - position));

    if (chunk.length === 0) {
      break;
    }

    parts.push(chunk);
    position += chunk.length;

    const newline = chunk.indexOf(newlineByte);

    if (newline !== -1) {
      const before = parts.slice(0, -1).reduce((sum, part) => sum + part.length, 0);
      const cut = before + newline + 1;
      const text = Buffer.concat(parts).subarray(0, cut).toString('utf8');

      return { text, nextOffset: offset + cut };
    }
  }

  return { text: '', nextOffset: offset };
};

export const readTranscriptChunk = async (
  path: string,
  offset: number,
  byteLimit: number,
): Promise<TranscriptChunk> => {
  parseChunkArguments(offset, byteLimit);

  let handle: FileHandle;

  try {
    handle = await open(path, 'r');
  } catch (error) {
    return isMissingFile(error)
      ? { status: 'missing' }
      : { status: 'unreadable', reason: errorMessage(error) };
  }

  try {
    const { size } = await handle.stat();
    const firstLength = Math.min(byteLimit, Math.max(0, size - offset));
    const first = await readBytes(handle, offset, firstLength);
    const newline = first.lastIndexOf(newlineByte);

    if (newline !== -1) {
      const cut = newline + 1;

      return {
        status: 'read',
        text: first.subarray(0, cut).toString('utf8'),
        nextOffset: offset + cut,
        size,
      };
    }

    if (offset + first.length >= size) {
      return { status: 'read', text: '', nextOffset: offset, size };
    }

    const found = await readToNewline(handle, first, offset, size);

    return { status: 'read', ...found, size };
  } catch (error) {
    return { status: 'unreadable', reason: errorMessage(error) };
  } finally {
    await handle.close();
  }
};
