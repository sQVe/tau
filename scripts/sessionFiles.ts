import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { isMissingFile } from '../src/errors.ts';

interface SessionFiles {
  managerSessions: string[];
  workerSessions: string[];
  workerRecords: string[];
}

const listFiles = async (directory: string) => {
  try {
    const names = await readdir(directory, { recursive: true, encoding: 'utf8' });

    return names.map((name) => join(directory, name));
  } catch (error) {
    // A missing directory holds no records; any other failure would fake an empty window.
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
