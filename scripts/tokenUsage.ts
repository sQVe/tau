import { open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { findSessionFiles } from './sessionFiles.ts';
import { formatTokenUsageReport, tokenUsageReport } from './tokenUsageReport.ts';
import type { SessionFile, Side } from './tokenUsageReport.ts';
import { ownsSession, parseAssignment, parseWorkerTask } from './workerRecord.ts';
import type { WorkerTask } from './workerRecord.ts';

interface TaskRecord {
  task: WorkerTask;
  directory: string;
}

interface UsageRecords {
  sessions: SessionFile[];
  skipped: { unreadableFiles: number; otherHarnessTasks: WorkerTask[] };
}

const usage = `Usage: node scripts/tokenUsage.ts [--since 7d] [--until <time>] [--top 10]

--since and --until take an ISO date or time, or an age such as 12h or 3d.`;

// Reads started together would open more files than the process may hold.
const readInTurn = async <Item, Result>(items: Item[], read: (item: Item) => Promise<Result>) => {
  const results: Result[] = [];

  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop -- One open file at a time.
    results.push(await read(item));
  }

  return results;
};

const readTask = async (path: string): Promise<TaskRecord | undefined> => {
  const source = await readFile(path, 'utf8').catch(() => '');
  const parse = basename(path) === 'assignment.json' ? parseAssignment : parseWorkerTask;
  const task = parse(source);

  return task === undefined ? undefined : { task, directory: dirname(path) };
};

const firstLineChunkBytes = 65_536;

const readFirstLine = async (path: string) => {
  const handle = await open(path);
  const chunks: Buffer[] = [];

  try {
    for (;;) {
      const buffer = Buffer.alloc(firstLineChunkBytes);
      // oxlint-disable-next-line no-await-in-loop -- Each chunk follows the one before it.
      const { bytesRead } = await handle.read(buffer, 0, firstLineChunkBytes, null);
      const chunk = buffer.subarray(0, bytesRead);
      const lineEnd = chunk.indexOf('\n');

      if (lineEnd !== -1) {
        chunks.push(chunk.subarray(0, lineEnd));

        break;
      }

      if (bytesRead === 0) {
        break;
      }

      chunks.push(chunk);
    }
  } finally {
    await handle.close();
  }

  return Buffer.concat(chunks).toString('utf8');
};

// A file last written before the window holds no entry inside it. Undefined means unreadable.
const findSession = async (path: string, side: Side, tasks: WorkerTask[], since: number) => {
  try {
    const { mtimeMs } = await stat(path);

    return mtimeMs < since ? null : { path, side, tasks, firstLine: await readFirstLine(path) };
  } catch {
    return undefined;
  }
};

const readSessionText = async (path: string) => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
};

export const findUsageRecords = async (
  agentDirectory: string,
  since: number,
): Promise<UsageRecords> => {
  const files = await findSessionFiles(agentDirectory);
  const tasks = await readInTurn(files.workerRecords, readTask);
  const records = tasks.filter((record) => record !== undefined);
  const recordDirectories = new Set(records.map((record) => record.directory));

  const tasksOf = (path: string) =>
    records
      .filter((record) => ownsSession(record.task, record.directory, path))
      .map((record) => record.task);

  const parentSessions = files.managerSessions.map((path) => ({ path, side: 'parent' as const }));
  const workerSessions = files.workerSessions.map((path) => ({ path, side: 'worker' as const }));

  const read = await readInTurn([...parentSessions, ...workerSessions], ({ path, side }) => {
    const owners = side === 'parent' ? [] : tasksOf(path);

    return findSession(path, side, owners, since);
  });

  const sessions: SessionFile[] = read.filter(
    (session) => session !== undefined && session !== null,
  );

  const unreadableSessions = read.filter((session) => session === undefined).length;

  const sessionsWithoutRecord = sessions.filter(
    (session) => session.side === 'worker' && !recordDirectories.has(dirname(session.path)),
  ).length;

  const otherHarnessTasks = records
    .map((record) => record.task)
    .filter((task) => task.harness !== 'pi');

  return {
    sessions,
    skipped: { unreadableFiles: sessionsWithoutRecord + unreadableSessions, otherHarnessTasks },
  };
};

const hoursPerDay = 24;
const millisecondsPerHour = 3_600_000;

export const parseTime = (value: string, now: number): number => {
  const age = /^(\d+)([hd])$/.exec(value);

  if (age !== null) {
    const hours = age[2] === 'd' ? Number(age[1]) * hoursPerDay : Number(age[1]);

    return now - hours * millisecondsPerHour;
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

  const records = await findUsageRecords(resolve(homedir(), '.pi', 'agent'), since);

  const report = await tokenUsageReport(
    records.sessions,
    { since, until },
    records.skipped,
    readSessionText,
  );

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
