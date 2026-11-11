import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { isMissingFile } from '../src/errors.ts';
import { isRecord } from '../src/schema.ts';
import {
  collectSessionFile,
  createHealthCollection,
  formatSessionHealthReport,
  sessionHealthReport,
} from './sessionHealthReport.ts';
import type { HealthCollection, Side, TimeWindow } from './sessionHealthReport.ts';
import { healthRules } from './sessionHealthRules.ts';
import { parseTime } from './tokenUsage.ts';

interface SessionPath {
  path: string;
  side: Side;
  started: number;
}

const usage = `Usage: node scripts/sessionHealth.ts [--since 7d] [--until <time>]

--since and --until take an ISO date or time, or an age such as 12h or 3d.`;

const listFiles = async (directory: string) => {
  try {
    const names = await readdir(directory, { recursive: true, encoding: 'utf8' });

    return names.map((name) => join(directory, name));
  } catch (error) {
    // A missing directory holds no sessions; any other failure would fake a healthy window.
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

const isWorkerSession = (path: string) =>
  path.endsWith('.jsonl') && ['assignments', 'workers'].includes(basename(dirname(dirname(path))));

const headerBytes = 65_536;

const readStart = async (path: string) => {
  const handle = await open(path);

  try {
    const buffer = Buffer.alloc(headerBytes);
    const { bytesRead } = await handle.read(buffer, 0, headerBytes, 0);
    const [firstLine = ''] = buffer.toString('utf8', 0, bytesRead).split('\n', 1);
    const header: unknown = JSON.parse(firstLine);

    const isHeader = isRecord(header) && header.type === 'session';

    return isHeader && typeof header.timestamp === 'string'
      ? Date.parse(header.timestamp)
      : Number.NaN;
  } finally {
    await handle.close();
  }
};

const findSession = async (
  path: string,
  side: Side,
  window: TimeWindow,
): Promise<SessionPath | null | undefined> => {
  try {
    const { mtimeMs } = await stat(path);

    if (mtimeMs < window.since) {
      return null;
    }

    const started = await readStart(path);

    if (Number.isNaN(started)) {
      return undefined;
    }

    return started >= window.until ? null : { path, side, started };
  } catch {
    return undefined;
  }
};

const findSessions = async (agentDirectory: string, window: TimeWindow) => {
  const managerPaths = await listFiles(join(agentDirectory, 'sessions'));
  const workerPaths = await listFiles(join(agentDirectory, 'tau'));

  const found = await Promise.all([
    ...managerPaths
      .filter((path) => path.endsWith('.jsonl'))
      .map((path) => findSession(path, 'manager', window)),
    ...workerPaths.filter(isWorkerSession).map((path) => findSession(path, 'worker', window)),
  ]);

  const sessions = found
    .filter((session) => session !== undefined && session !== null)
    .toSorted((left, right) => left.started - right.started);

  return { sessions, unreadableFiles: found.filter((session) => session === undefined).length };
};

export const collectSessions = async (
  agentDirectory: string,
  window: TimeWindow,
): Promise<{ collection: HealthCollection; unreadableFiles: number }> => {
  const { sessions, unreadableFiles } = await findSessions(agentDirectory, window);
  const collection = createHealthCollection(window);
  let unreadable = unreadableFiles;

  for (const session of sessions) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- One file at a time, since a week of sessions can hold gigabytes.
      const text = await readFile(session.path, 'utf8');

      collectSessionFile(collection, { path: session.path, side: session.side, text });
    } catch {
      unreadable += 1;
    }
  }

  return { collection, unreadableFiles: unreadable };
};

const main = async () => {
  const { values } = parseArgs({
    options: { since: { type: 'string', default: '7d' }, until: { type: 'string' } },
  });

  const now = Date.now();
  const since = parseTime(values.since, now);
  const until = values.until === undefined ? now : parseTime(values.until, now);

  if (since >= until) {
    throw new Error(`--since must be before --until. ${usage}`);
  }

  const { collection, unreadableFiles } = await collectSessions(
    resolve(homedir(), '.pi', 'agent'),
    { since, until },
  );

  const report = sessionHealthReport(collection, { rules: healthRules, unreadableFiles });

  process.stdout.write(formatSessionHealthReport(report));
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
