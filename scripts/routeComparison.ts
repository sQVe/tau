import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { isMissingFile } from '../src/errors.ts';
import { isRecord } from '../src/schema.ts';
import { formatRouteComparisonReport } from './routeComparisonFormat.ts';
import { parseRouteRecord, routeComparisonReport } from './routeComparisonReport.ts';
import type {
  ComparisonOptions,
  ParsedRecord,
  RecordFile,
  RecordKind,
} from './routeComparisonReport.ts';

interface Candidate {
  kind: RecordKind;
  path: string;
}

const usage = `Usage: node scripts/routeComparison.ts --profile <profile> --label <label> --switch <date>
  [--model <model>] [--since <date>] [--until <date>] [--agent-directory <path>] [--list]`;

const archivePattern = /^[^/]+\/[^/]+\/task\.json$/;
const workerPattern = /^[^/]+\/workers\/[^/]+\/task\.json$/;
const assignmentPattern = /^[^/]+\/assignments\/[^/]+\/assignment\.json$/;

const listRelative = async (root: string) => {
  try {
    return await readdir(root, { recursive: true, encoding: 'utf8' });
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

const readText = async (path: string) => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    // A missing file holds no record; any other failure would fake an empty window.
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

const statTime = async (path: string) => {
  try {
    const info = await stat(path);

    return info.mtimeMs;
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

const assignmentSessionFile = (source: string): string | undefined => {
  let value: unknown;

  try {
    value = JSON.parse(source);
  } catch {
    return undefined;
  }

  if (!isRecord(value) || !isRecord(value.session)) {
    return undefined;
  }

  const file = value.session.file;

  return typeof file === 'string' ? file : undefined;
};

const readReport = async (path: string) => {
  const reportPath = join(dirname(path), 'report.json');
  const reportText = await readText(reportPath);

  if (reportText === undefined) {
    return {};
  }

  const reportTime = await statTime(reportPath);

  return { reportText, ...(reportTime === undefined ? {} : { reportTime }) };
};

const readRecordFile = async (candidate: Candidate): Promise<RecordFile> => {
  const text = (await readText(candidate.path)) ?? '';

  if (candidate.kind === 'assignment') {
    const sessionFile = assignmentSessionFile(text);
    const sessionText = sessionFile === undefined ? undefined : await readText(sessionFile);

    return { kind: candidate.kind, text, ...(sessionText === undefined ? {} : { sessionText }) };
  }

  return { kind: candidate.kind, text, ...(await readReport(candidate.path)) };
};

const archiveCandidates = (root: string, names: string[]) =>
  names
    .filter((name) => archivePattern.test(name))
    .map((name) => ({ kind: 'archive' as const, path: join(root, name) }));

const readRecords = async (agentDirectory: string): Promise<ParsedRecord[]> => {
  const archive = join(agentDirectory, 'tau-archive');
  const tau = join(agentDirectory, 'tau');
  const [archiveNames, tauNames] = await Promise.all([listRelative(archive), listRelative(tau)]);

  const candidates: Candidate[] = [
    ...archiveCandidates(archive, archiveNames),
    ...tauNames
      .filter((name) => workerPattern.test(name))
      .map((name) => ({ kind: 'worker' as const, path: join(tau, name) })),
    ...tauNames
      .filter((name) => assignmentPattern.test(name))
      .map((name) => ({ kind: 'assignment' as const, path: join(tau, name) })),
  ];

  const records: ParsedRecord[] = [];

  for (const candidate of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- Parallel reads would hold every session log at once.
    records.push(parseRouteRecord(await readRecordFile(candidate)));
  }

  return records;
};

const parseDate = (value: string, name: string) => {
  const time = Date.parse(value);

  if (Number.isNaN(time)) {
    throw new TypeError(`Cannot read ${name} "${value}" as a date. ${usage}`);
  }

  return time;
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string' },
      label: { type: 'string' },
      switch: { type: 'string' },
      model: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      'agent-directory': { type: 'string' },
      list: { type: 'boolean' },
    },
  });

  const { profile, label, switch: switchValue } = values;

  if (profile === undefined || label === undefined || switchValue === undefined) {
    throw new Error(`--profile, --label, and --switch are required. ${usage}`);
  }

  const options: ComparisonOptions = {
    profile,
    label,
    switch: parseDate(switchValue, '--switch'),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values.since === undefined ? {} : { since: parseDate(values.since, '--since') }),
    ...(values.until === undefined ? {} : { until: parseDate(values.until, '--until') }),
  };

  const agentDirectory = values['agent-directory'] ?? resolve(homedir(), '.pi', 'agent');
  const parsed = await readRecords(agentDirectory);
  const report = routeComparisonReport(parsed, options);

  process.stdout.write(formatRouteComparisonReport(report, values.list ?? false));
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
