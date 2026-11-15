import { constants } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { errorMessage, isMissingFile } from '../errors.ts';
import type { WorkerTranscript } from './taskMapping.ts';
import { parseTranscript } from './transcript.ts';
import type { Transcript } from './transcript.ts';
import { ownsSession, parseAssignment, parseWorkerTask } from './workerRecord.ts';
import type { WorkerTask } from './workerRecord.ts';

interface SessionFiles {
  managerSessions: string[];
  workerSessions: string[];
  workerRecords: string[];
}

export interface WorkerRecord {
  task: WorkerTask;
  directory: string;
}

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

export const readWorkerRecord = async (path: string): Promise<WorkerRecord | undefined> => {
  const source = await readFile(path, 'utf8').catch(() => '');
  const parse = basename(path) === 'assignment.json' ? parseAssignment : parseWorkerTask;
  const task = parse(source);

  return task === undefined ? undefined : { task, directory: dirname(path) };
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

const readability = async (path: string): Promise<WorkerTranscript> => {
  try {
    await access(path, constants.R_OK);

    return 'readable';
  } catch (error) {
    return isMissingFile(error) ? 'missing' : 'unreadable';
  }
};

const combinedReadability = (results: readonly WorkerTranscript[]): WorkerTranscript => {
  if (results.includes('unreadable')) {
    return 'unreadable';
  }

  return results.includes('readable') ? 'readable' : 'missing';
};

// Finds the transcript of each worker with a readable record, by task or assignment ID.
export const readWorkerTranscripts = async (
  agentDirectory: string,
): Promise<Map<string, WorkerTranscript>> => {
  const { workerRecords, workerSessions } = await findSessionFiles(agentDirectory);
  const workers = new Map<string, WorkerTranscript>();

  for (const recordPath of workerRecords) {
    // oxlint-disable-next-line no-await-in-loop -- Reads started together would open too many files.
    const record = await readWorkerRecord(recordPath);

    if (record === undefined) {
      continue;
    }

    const sessions = workerSessions.filter((path) =>
      ownsSession(record.task, record.directory, path),
    );

    // oxlint-disable-next-line no-await-in-loop -- Reads started together would open too many files.
    const results = await Promise.all(sessions.map(readability));

    workers.set(record.task.taskId, combinedReadability(results));
  }

  return workers;
};
