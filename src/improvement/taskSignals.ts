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

type ReadResult<Value> = { status: 'read'; value: Value } | { status: 'failed'; reason: string };

const listSessionPaths = async (directory: string): Promise<ReadResult<string[]>> => {
  try {
    const names = await readdir(directory, { encoding: 'utf8' });

    const paths = names
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(directory, name));

    return { status: 'read', value: paths };
  } catch (error) {
    if (isMissingFile(error)) {
      return { status: 'read', value: [] };
    }

    return { status: 'failed', reason: errorMessage(error) };
  }
};

const changedSince = async (
  paths: readonly string[],
  createdAt: number,
): Promise<ReadResult<string[]>> => {
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

      return { status: 'failed', reason: `${path}: ${errorMessage(error)}` };
    }

    if (lastChanged >= createdAt) {
      kept.push(path);
    }
  }

  return { status: 'read', value: kept };
};

const readSessionTranscripts = async (
  paths: readonly string[],
): Promise<ReadResult<TranscriptFact[]>> => {
  const transcripts: TranscriptFact[] = [];

  for (const path of paths) {
    // oxlint-disable-next-line no-await-in-loop -- Reads started together would open too many files.
    const transcript = await readTranscript(path);

    if (transcript.status === 'unreadable') {
      return { status: 'failed', reason: `${path}: ${transcript.reason}` };
    }

    transcripts.push({ path, transcript });
  }

  return { status: 'read', value: transcripts };
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
): Promise<ReadResult<MappingFacts['workers']>> => {
  if (workerIds.size === 0) {
    return { status: 'read', value: new Map<string, WorkerTranscript>() };
  }

  try {
    const workers = await readWorkerTranscripts(agentDirectory, workerIds);

    return { status: 'read', value: workers };
  } catch (error) {
    return { status: 'failed', reason: errorMessage(error) };
  }
};

export const readTaskSignals = async (sources: TaskSignalSources): Promise<TaskSignalsRead> => {
  const createdAt = Date.parse(sources.pullRequest.createdAt);

  if (Number.isNaN(createdAt)) {
    return {
      status: 'failed',
      reason: `The pull request creation time "${sources.pullRequest.createdAt}" is not a date.`,
    };
  }

  const listing = await listSessionPaths(sources.sessionDirectory);

  if (listing.status === 'failed') {
    return listing;
  }

  const recent = await changedSince(listing.value, createdAt);

  if (recent.status === 'failed') {
    return recent;
  }

  const transcripts = await readSessionTranscripts(recent.value);

  if (transcripts.status === 'failed') {
    return transcripts;
  }

  const mapping = (workers: MappingFacts['workers']) =>
    mapTasks({
      pullRequests: [sources.pullRequest],
      transcripts: transcripts.value,
      repositories: new Map([[sources.cwd, sources.pullRequest.repository]]),
      workers,
    });

  const firstTask = mapping(new Map<string, WorkerTranscript>()).tasks[0];
  const workerIds = workerIdsOf(firstTask?.facts ?? []);
  const workers = await readWorkersFor(sources.agentDirectory, workerIds);

  if (workers.status === 'failed') {
    return workers;
  }

  const task = mapping(workers.value).tasks[0];

  if (task === undefined) {
    return { status: 'failed', reason: 'The task mapping returned no task.' };
  }

  return {
    status: 'read',
    signals: decideReviewSignals({
      evidence: { facts: task.facts, missing: task.missing },
      reverted: false,
      coverage: task.coverage,
    }),
    coverage: task.coverage,
  };
};
