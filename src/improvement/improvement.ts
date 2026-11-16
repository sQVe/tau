import { readdir, readFile } from 'node:fs/promises';
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
): Promise<Map<string, WorkerTranscript>> => {
  const { workerRecords, workerSessions } = await findSessionFiles(agentDirectory);
  const workers = new Map<string, WorkerTranscript>();

  for (const recordPath of workerRecords) {
    // oxlint-disable-next-line no-await-in-loop -- Reads started together would open too many files.
    const read = await readWorkerRecord(recordPath);

    if (read.status !== 'read' && read.status !== 'missing') {
      workers.set(basename(dirname(recordPath)), 'unreadable');
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
