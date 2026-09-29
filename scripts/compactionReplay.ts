import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { compactionReplayReport, formatCompactionReplayReport } from './compactionReplayReport.ts';
import { listFiles, parseTime, readSession } from './tokenUsage.ts';

const usage = `Usage: node scripts/compactionReplay.ts [--since 7d] [--until <time>] [--threshold 150k,200k,300k]

--since and --until take an ISO date or time, or an age such as 12h or 3d. --threshold takes
context tokens, such as 200000 or 200k, and can repeat.`;

// Reads the parent (manager) sessions under `sessions/`; workers keep theirs under `tau/`.
export const readParentSessions = async (agentDirectory: string, since: number) => {
  const paths = await listFiles(join(agentDirectory, 'sessions'));

  const read = await Promise.all(
    paths
      .filter((path) => path.endsWith('.jsonl'))
      .map((path) => readSession(path, 'parent', [], since)),
  );

  return {
    sessions: read.filter((session) => session !== undefined && session !== null),
    unreadableFiles: read.filter((session) => session === undefined).length,
  };
};

export const parseThresholds = (values: string[]) =>
  values
    .flatMap((value) => value.split(','))
    .map((value) => {
      const match = /^(\d+)(k?)$/.exec(value.trim());

      if (match === null) {
        throw new TypeError(`Cannot read the threshold "${value}". ${usage}`);
      }

      const threshold = Number(match[1]) * (match[2] === 'k' ? 1000 : 1);

      if (threshold === 0) {
        throw new TypeError(`A threshold must be above 0, not "${value}".`);
      }

      return threshold;
    });

const main = async () => {
  const { values } = parseArgs({
    options: {
      since: { type: 'string', default: '7d' },
      until: { type: 'string' },
      threshold: { type: 'string', multiple: true, default: ['150k,200k,300k'] },
    },
  });

  const now = Date.now();
  const since = parseTime(values.since, now);
  const until = values.until === undefined ? now : parseTime(values.until, now);
  const thresholds = parseThresholds(values.threshold);

  if (since >= until) {
    throw new Error('--since must be before --until.');
  }

  const records = await readParentSessions(resolve(homedir(), '.pi', 'agent'), since);

  const report = compactionReplayReport(
    records.sessions,
    { since, until },
    thresholds,
    records.unreadableFiles,
  );

  process.stdout.write(formatCompactionReplayReport(report));
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
