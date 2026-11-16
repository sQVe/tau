import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage, isMissingFile } from '../errors.ts';
import { readTranscript, readWorkerTranscripts } from './improvement.ts';
import { decideReviewSignals } from './signals.ts';
import type { ReviewSignals } from './signals.ts';
import type { TaskFact } from './taskFacts.ts';
import { mapTasks } from './taskMapping.ts';
import type {
  Coverage,
  MappingFacts,
  MergedPullRequest,
  TranscriptFact,
  WorkerTranscript,
} from './taskMapping.ts';

export type { Coverage, MergedPullRequest } from './taskMapping.ts';
export type { ReviewSignals } from './signals.ts';

export interface TaskSignalSources {
  agentDirectory: string;
  sessionDirectory: string;
  cwd: string;
  pullRequest: MergedPullRequest;
}

export type TaskSignalsRead =
  | { status: 'read'; signals: ReviewSignals; coverage: Coverage }
  | { status: 'failed'; reason: string };

const listSessionPaths = async (directory: string): Promise<string[]> => {
  try {
    const names = await readdir(directory, { encoding: 'utf8' });

    return names.filter((name) => name.endsWith('.jsonl')).map((name) => join(directory, name));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

const changedSince = async (paths: readonly string[], createdAt: number): Promise<string[]> => {
  const kept: string[] = [];

  for (const path of paths) {
    let lastChanged: number;

    try {
      // oxlint-disable-next-line no-await-in-loop -- Reads started together would open too many files.
      const entry = await stat(path);

      lastChanged = entry.mtimeMs;
    } catch (error) {
      if (isMissingFile(error)) {
        continue;
      }

      throw new Error(`${path}: ${errorMessage(error)}`, { cause: error });
    }

    if (lastChanged >= createdAt) {
      kept.push(path);
    }
  }

  return kept;
};

const readSessionTranscripts = async (paths: readonly string[]): Promise<TranscriptFact[]> => {
  const transcripts: TranscriptFact[] = [];

  for (const path of paths) {
    // oxlint-disable-next-line no-await-in-loop -- Reads started together would open too many files.
    const transcript = await readTranscript(path);

    if (transcript.status === 'unreadable') {
      throw new Error(`${path}: ${transcript.reason}`);
    }

    transcripts.push({ path, transcript });
  }

  return transcripts;
};

const workerIdsOf = (facts: readonly TaskFact[]): ReadonlySet<string> => {
  const workerIds = new Set<string>();

  for (const fact of facts) {
    if (fact.kind === 'launch' && fact.workerId !== undefined) {
      workerIds.add(fact.workerId);
    }
  }

  return workerIds;
};

const readWorkersFor = async (
  agentDirectory: string,
  workerIds: ReadonlySet<string>,
): Promise<MappingFacts['workers']> => {
  if (workerIds.size === 0) {
    return new Map<string, WorkerTranscript>();
  }

  return readWorkerTranscripts(agentDirectory, workerIds);
};

const mapOneTask = (
  sources: TaskSignalSources,
  transcripts: readonly TranscriptFact[],
  workers: MappingFacts['workers'],
) => {
  const [task] = mapTasks({
    pullRequests: [sources.pullRequest],
    transcripts,
    repositories: new Map([[sources.cwd, sources.pullRequest.repository]]),
    workers,
  }).tasks;

  if (task === undefined) {
    throw new Error('The task mapping returned no task.');
  }

  return task;
};

export const readTaskSignals = async (sources: TaskSignalSources): Promise<TaskSignalsRead> => {
  const createdAt = Date.parse(sources.pullRequest.createdAt);

  if (Number.isNaN(createdAt)) {
    return {
      status: 'failed',
      reason: `The pull request creation time "${sources.pullRequest.createdAt}" is not a date.`,
    };
  }

  try {
    const paths = await listSessionPaths(sources.sessionDirectory);
    const recent = await changedSince(paths, createdAt);
    const transcripts = await readSessionTranscripts(recent);

    const firstTask = mapOneTask(sources, transcripts, new Map<string, WorkerTranscript>());
    const workerIds = workerIdsOf(firstTask.facts);
    const workers = await readWorkersFor(sources.agentDirectory, workerIds);
    const task = mapOneTask(sources, transcripts, workers);

    return {
      status: 'read',
      signals: decideReviewSignals({
        evidence: { facts: task.facts, missing: task.missing },
        reverted: false,
        coverage: task.coverage,
      }),
      coverage: task.coverage,
    };
  } catch (error) {
    return { status: 'failed', reason: errorMessage(error) };
  }
};
