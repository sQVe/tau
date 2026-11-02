import { createHash } from 'node:crypto';
import { constants, lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { listSavedLogs } from '../../checkRecord/checkRecord.js';
import { readCheckState } from '../../checkRecord/identity.js';
import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { readRepositoryArgv } from '../../config/repositoryCommand.js';
import { errorMessage, isMissingFile } from '../../errors.js';
import { readGit, runGit } from '../../git.js';
import {
  checkLogGaps,
  decideFullCheck,
  excerptBody,
  matchCheckLog,
  selectLatestChecks,
} from './evidenceDecisions.js';
import type {
  CheckHeaderIdentity,
  CheckLog,
  FullCheckDecision,
  ModifiedCheckLog,
  PublicationGap,
} from './evidenceDecisions.js';

export interface PublicationConfig {
  location: ConfigLocation;
  ui: ConfigWarnings;
}

export type FullCheckEvidence = FullCheckDecision & { excerpt?: string; truncated?: boolean };

export interface CheckEvidence {
  checks: CheckLog[];
  fullCheck: FullCheckEvidence | null;
  gaps: PublicationGap[];
}

const readChecksFailure = (error: unknown): PublicationGap => ({
  kind: 'checks',
  reason: errorMessage(error),
});

const hashOutput = async (root: string, commandArguments: string[]) => {
  const result = await runGit(root, commandArguments);

  if (result.exitCode !== 0) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return createHash('sha256').update(result.stdout).digest('hex');
};

const readHeaderIdentity = async (
  root: string,
  mergeBase: string,
): Promise<CheckHeaderIdentity> => ({
  head: await readGit(root, ['rev-parse', 'HEAD']),
  status: await hashOutput(root, ['--no-optional-locks', 'status', '--porcelain']),
  diff: await hashOutput(root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    mergeBase,
    'HEAD',
  ]),
});

export const readCheckHeader = async (
  root: string,
  mergeBase: string | undefined,
): Promise<{ lines: string[] }> => {
  if (mergeBase === undefined) {
    throw new Error('checkHeader needs mergeBase.');
  }

  const commit = await readGit(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${mergeBase}^{commit}`,
  ]);

  const identity = await readHeaderIdentity(root, commit);

  return {
    lines: [`HEAD: ${identity.head}`, `Status: ${identity.status}`, `Diff: ${identity.diff}`],
  };
};

const readDirectory = async (path: string) => {
  try {
    const entry = await lstat(path);

    if (!entry.isDirectory()) {
      throw new Error(`Not a regular directory: ${path}`);
    }

    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

const readCheckLog = async (
  path: string,
  current: CheckHeaderIdentity | null,
): Promise<ModifiedCheckLog> => {
  let modifiedAt: number | null = null;
  let check: CheckLog;

  try {
    const entry = await lstat(path);

    modifiedAt = entry.mtimeMs;

    if (!entry.isFile()) {
      throw new Error(`Not a regular check log: ${path}`);
    }

    const text = await readFile(path, {
      encoding: 'utf8',
      flag: constants.O_RDONLY | constants.O_NOFOLLOW,
    });

    check = matchCheckLog(path, text, current);
  } catch (error) {
    check = {
      path,
      matches: false,
      reasons: [{ field: 'read', reason: errorMessage(error) }],
      excerpt: null,
      truncated: false,
    };
  }

  return { name: basename(path), modifiedAt, check };
};

const readRunChecks = async (directory: string, current: CheckHeaderIdentity | null) => {
  const entries = await readDirectory(directory);

  const paths = entries
    .filter((entry) => entry.name.endsWith('.log'))
    .map((entry) => join(directory, entry.name))
    .toSorted();

  return Promise.all(paths.map((path) => readCheckLog(path, current)));
};

const readChecks = async (
  root: string,
  mergeBase: string | undefined,
  fullCheck: FullCheckEvidence | null,
  gaps: PublicationGap[],
): Promise<CheckLog[]> => {
  let current: CheckHeaderIdentity | null = null;

  if (mergeBase !== undefined) {
    try {
      current = await readHeaderIdentity(root, mergeBase);
    } catch (error) {
      gaps.push(readChecksFailure(error));
    }
  }

  const logs: ModifiedCheckLog[] = [];

  try {
    await readDirectory(join(root, '.tau'));

    const directory = join(root, '.tau', 'pr');
    const entries = await readDirectory(directory);

    const runs = entries
      .filter((entry) => entry.name.startsWith('run-'))
      .toSorted((left, right) => left.name.localeCompare(right.name));

    for (const run of runs) {
      try {
        const runDirectory = join(directory, run.name);

        // oxlint-disable-next-line no-await-in-loop -- reject linked run directories before reading their checks.
        await readDirectory(runDirectory);

        // oxlint-disable-next-line no-await-in-loop -- read one run at a time and retain failures from each.
        logs.push(...(await readRunChecks(join(runDirectory, 'checks'), current)));
      } catch (error) {
        gaps.push(readChecksFailure(error));
      }
    }
  } catch (error) {
    gaps.push(readChecksFailure(error));
  }

  const checks = selectLatestChecks(logs);

  gaps.push(...checkLogGaps(checks, fullCheck));

  return checks;
};

const readLogExcerpt = async (logPath: string) => {
  const text = await readFile(logPath, 'utf8');
  const body = text.split('\n');

  if (body.at(-1) === '') {
    body.pop();
  }

  return excerptBody(body);
};

const readFullCheck = async (
  root: string,
  mergeBase: string | undefined,
  config: PublicationConfig,
  gaps: PublicationGap[],
): Promise<FullCheckEvidence | null> => {
  if (mergeBase === undefined) {
    return null;
  }

  let fullCheck: FullCheckEvidence | null = null;

  try {
    const state = await readCheckState(root);
    const saved = await listSavedLogs(join(root, '.tau', 'checks'));
    const { argv } = readRepositoryArgv(config.location, config.ui, 'fullCheck');
    const decision = decideFullCheck(state, argv, saved);

    fullCheck = decision;

    if (decision.status === 'passed' || decision.status === 'failed') {
      fullCheck = { ...decision, ...(await readLogExcerpt(decision.logPath)) };
    }

    if (decision.status !== 'passed') {
      gaps.push({ kind: 'fullCheck', status: decision.status });
    }
  } catch (error) {
    gaps.push(readChecksFailure(error));
  }

  return fullCheck;
};

export const readCheckEvidence = async (
  root: string,
  mergeBase: string | undefined,
  config: PublicationConfig,
): Promise<CheckEvidence> => {
  const gaps: PublicationGap[] = [];
  const fullCheck = await readFullCheck(root, mergeBase, config, gaps);
  const checks = await readChecks(root, mergeBase, fullCheck, gaps);

  return { checks, fullCheck, gaps };
};
