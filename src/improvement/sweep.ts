import { join } from 'node:path';

import type { Exec } from '../command.ts';
import { errorMessage } from '../errors.ts';
import { withFileLock } from '../fileLock/fileLock.ts';
import { discoverTranscripts } from './sweepDiscovery.ts';
import { readSweepIndex, writeSweepIndex } from './sweepIndex.ts';
import type { SweepIndex } from './sweepIndex.ts';
import { runProject } from './sweepProject.ts';

export interface SweepOptions {
  agentDirectory: string;
  cwd: string;
  exec: Exec;
  now: () => Date;
  budgetMilliseconds: number;
  since: string;
  signal: AbortSignal;
}

export type SweepOutcome =
  | { outcome: 'caughtUp' }
  | { outcome: 'budget' }
  | { outcome: 'failed'; reason: string };

interface ProjectsResult {
  status: 'budget' | 'done';
  index: SweepIndex;
  failure?: string;
}

class SweepBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SweepBudgetError';
  }
}

const emptyIndex = (): SweepIndex => ({
  version: 1,
  transcripts: {},
  projects: {},
  lastSweep: null,
});

const writeIndex = async (
  options: SweepOptions,
  index: SweepIndex,
  lastSweep: SweepIndex['lastSweep'],
): Promise<string | undefined> => {
  try {
    await writeSweepIndex(options.agentDirectory, { ...index, lastSweep });

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

const finishBudget = async (
  options: SweepOptions,
  index: SweepIndex,
  startedAt: string,
): Promise<SweepOutcome> => {
  const error = await writeIndex(options, index, { startedAt, outcome: 'budget' });

  return error === undefined ? { outcome: 'budget' } : { outcome: 'failed', reason: error };
};

const finishFailed = async (
  options: SweepOptions,
  index: SweepIndex,
  startedAt: string,
  reason: string,
): Promise<SweepOutcome> => {
  const error = await writeIndex(options, index, { startedAt, outcome: 'failed', reason });

  return { outcome: 'failed', reason: error ?? reason };
};

const runProjects = async (
  options: SweepOptions,
  index: SweepIndex,
  deadline: number,
  signal: AbortSignal,
  repositories: ReadonlyMap<string, string>,
): Promise<ProjectsResult> => {
  let current = index;
  let failure: string | undefined;

  for (const projectRoot of Object.keys(current.projects).toSorted()) {
    if (signal.aborted || options.now().getTime() >= deadline) {
      return { status: 'budget', index: current };
    }

    const entry = current.projects[projectRoot];

    // oxlint-disable-next-line no-await-in-loop -- Each project is read before the next starts.
    const result = await runProject({
      agentDirectory: options.agentDirectory,
      projectRoot,
      index: current,
      exec: options.exec,
      now: options.now,
      since: options.since,
      signal,
      deadline,
      repositories,
      repository: entry?.repository ?? null,
    });

    if (result.status === 'budget') {
      return { status: 'budget', index: current };
    }

    if (result.status === 'unknown') {
      failure ??= result.reason;
    }

    current = result.index;
  }

  return {
    status: 'done',
    index: current,
    ...(failure === undefined ? {} : { failure }),
  };
};

const runLocked = async (
  options: SweepOptions,
  startedAt: string,
  deadline: number,
  signal: AbortSignal,
): Promise<SweepOutcome> => {
  const read = await readSweepIndex(options.agentDirectory);

  if (read.status === 'newer') {
    return { outcome: 'failed', reason: read.notice };
  }

  const index = read.status === 'read' ? read.index : emptyIndex();

  const discovery = await discoverTranscripts({
    agentDirectory: options.agentDirectory,
    index,
    exec: options.exec,
    signal,
    now: options.now,
    deadline,
  });

  if (discovery.status === 'budget') {
    return finishBudget(options, discovery.index, startedAt);
  }

  if (discovery.status === 'failed') {
    return finishFailed(options, index, startedAt, discovery.reason);
  }

  const projects = await runProjects(
    options,
    discovery.index,
    deadline,
    signal,
    discovery.repositories,
  );

  if (projects.status === 'budget') {
    return finishBudget(options, projects.index, startedAt);
  }

  const lastSweep =
    projects.failure === undefined
      ? { startedAt, outcome: 'caughtUp' as const }
      : { startedAt, outcome: 'failed' as const, reason: projects.failure };

  const error = await writeIndex(options, projects.index, lastSweep);

  if (error !== undefined) {
    return { outcome: 'failed', reason: error };
  }

  return projects.failure === undefined
    ? { outcome: 'caughtUp' }
    : { outcome: 'failed', reason: projects.failure };
};

export const runSweep = async (options: SweepOptions): Promise<SweepOutcome> => {
  if (!Number.isInteger(options.budgetMilliseconds) || options.budgetMilliseconds < 1) {
    throw new RangeError('budgetMilliseconds must be a positive integer.');
  }

  const startedAt = options.now().toISOString();
  const deadline = options.now().getTime() + options.budgetMilliseconds;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.budgetMilliseconds)]);
  const lockPath = join(options.agentDirectory, 'tau', 'improvement', 'sweep.lock');

  try {
    return await withFileLock(
      {
        cancelled: () =>
          new SweepBudgetError('The sweep budget ran out while waiting for the lock.'),
        lockPath,
        checkout: options.cwd,
        signal,
        pollMilliseconds: 100,
        onWaiting: () => undefined,
      },
      () => runLocked(options, startedAt, deadline, signal),
    );
  } catch (error) {
    if (error instanceof SweepBudgetError) {
      return { outcome: 'budget' };
    }

    return { outcome: 'failed', reason: errorMessage(error) };
  }
};
