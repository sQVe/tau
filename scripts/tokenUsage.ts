import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { isMissingFile } from '../src/errors/index.ts';
import {
  formatTokenUsageReport,
  ownsSession,
  parseWorkerTask,
  tokenUsageReport,
} from './tokenUsageReport.ts';
import type { SessionFile, Side, WorkerTask } from './tokenUsageReport.ts';

interface TaskRecord {
  task: WorkerTask;
  directory: string;
}

const usage = `Usage: node scripts/tokenUsage.ts [--since 7d] [--until <time>] [--top 10]

--since and --until take an ISO date or time, or an age such as 12h or 3d.`;

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

const readTask = async (path: string): Promise<TaskRecord | undefined> => {
  const task = parseWorkerTask(await readFile(path, 'utf8').catch(() => ''));

  return task === undefined ? undefined : { task, directory: dirname(path) };
};

// A file last written before the window holds no entry inside it. Undefined means unreadable.
const readSession = async (path: string, side: Side, tasks: WorkerTask[], since: number) => {
  try {
    const { mtimeMs } = await stat(path);

    return mtimeMs < since ? null : { path, side, tasks, text: await readFile(path, 'utf8') };
  } catch {
    return undefined;
  }
};

// Reads parent sessions under `sessions/` and worker sessions beside a task record under `tau/`.
export const readUsageRecords = async (agentDirectory: string, since: number) => {
  const parentPaths = await listFiles(join(agentDirectory, 'sessions'));
  const workerFiles = await listFiles(join(agentDirectory, 'tau'));
  const taskPaths = workerFiles.filter((path) => basename(path) === 'task.json');
  const taskDirectories = new Set(taskPaths.map((path) => dirname(path)));
  const tasks = await Promise.all(taskPaths.map(readTask));
  const records = tasks.filter((record) => record !== undefined);

  const tasksOf = (path: string) =>
    records
      .filter((record) => ownsSession(record.task, record.directory, path))
      .map((record) => record.task);

  const reads = [
    ...parentPaths
      .filter((path) => path.endsWith('.jsonl'))
      .map((path) => readSession(path, 'parent', [], since)),
    ...workerFiles
      .filter((path) => path.endsWith('.jsonl') && taskDirectories.has(dirname(path)))
      .map((path) => readSession(path, 'worker', tasksOf(path), since)),
  ];

  const read = await Promise.all(reads);

  const sessions: SessionFile[] = read.filter(
    (session) => session !== undefined && session !== null,
  );

  const unreadableSessions = read.filter((session) => session === undefined).length;
  const readDirectories = new Set(sessions.map((session) => dirname(session.path)));

  // A broken task record matters only when its session is part of this window.
  const unreadableTasks = taskPaths.filter(
    (path, index) => tasks[index] === undefined && readDirectories.has(dirname(path)),
  ).length;

  const otherHarnessTasks = records
    .map((record) => record.task)
    .filter((task) => task.harness !== 'pi');

  return {
    sessions,
    skipped: { unreadableFiles: unreadableTasks + unreadableSessions, otherHarnessTasks },
  };
};

export const parseTime = (value: string, now: number) => {
  const age = /^(\d+)([hd])$/.exec(value);

  if (age !== null) {
    const hours = age[2] === 'd' ? Number(age[1]) * 24 : Number(age[1]);

    return now - hours * 3_600_000;
  }

  // Date.parse reads a bare number as a year or month, such as 7 as July 2001.
  if (/^\d+$/.test(value)) {
    throw new TypeError(`Add a unit to "${value}", such as ${value}h or ${value}d. ${usage}`);
  }

  const time = Date.parse(value);

  if (Number.isNaN(time)) {
    throw new TypeError(`Cannot read the time "${value}". ${usage}`);
  }

  return time;
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      since: { type: 'string', default: '7d' },
      until: { type: 'string' },
      top: { type: 'string', default: '10' },
    },
  });

  const now = Date.now();
  const since = parseTime(values.since, now);
  const until = values.until === undefined ? now : parseTime(values.until, now);
  const top = Number(values.top);

  if (!Number.isInteger(top) || top < 1) {
    throw new Error(`--top must be a positive integer, not "${values.top}".`);
  }

  if (since >= until) {
    throw new Error('--since must be before --until.');
  }

  const records = await readUsageRecords(resolve(homedir(), '.pi', 'agent'), since);
  const report = tokenUsageReport(records.sessions, { since, until }, records.skipped);

  process.stdout.write(formatTokenUsageReport(report, top));
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
