import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

import type { Exec } from '../command.ts';
import { errorMessage, isMissingFile } from '../errors.ts';
import { parseRepository, readMergedPullRequests } from '../github/github.ts';
import type { MergedPullRequestListing } from '../github/github.ts';
import { readEvents, writeEvent } from './event.ts';
import { readTranscriptChunk, readWorkerTranscripts } from './improvement.ts';
import { decideTranscriptRead, plannedEvents } from './sweepDecision.ts';
import { resolveTranscript } from './sweepDiscovery.ts';
import type { SweepIndex } from './sweepIndex.ts';
import { keepFactCalls } from './taskFacts.ts';
import { mapTasks } from './taskMapping.ts';
import type { MergedPullRequest, TranscriptFact } from './taskMapping.ts';
import { continueTranscript, finishTranscript } from './transcript.ts';
import type { TranscriptState } from './transcript.ts';

export interface ProjectOptions {
  agentDirectory: string;
  projectRoot: string;
  index: SweepIndex;
  exec: Exec;
  now: () => Date;
  since: string;
  signal: AbortSignal;
  deadline: number;
  repositories: ReadonlyMap<string, string>;
  repository: string | null;
}

export type ProjectResult =
  | { status: 'done'; index: SweepIndex }
  | { status: 'budget' }
  | { status: 'unknown'; reason: string; index: SweepIndex };

type ProjectSync =
  | { status: 'done'; index: SweepIndex }
  | { status: 'budget' }
  | { status: 'unknown'; reason: string };

type ResolvedEntry = Extract<SweepIndex['transcripts'][string], { status: 'resolved' }>;

type AdvanceResult =
  | { status: 'ok'; cursor: number; state: TranscriptState }
  | { status: 'removed' }
  | { status: 'budget' }
  | { status: 'unknown'; reason: string };

// oxlint-disable-next-line no-magic-numbers -- A 16 MiB chunk keeps the number of reads low.
const chunkSize = 16 * 1024 * 1024;

const deadlineReached = (options: ProjectOptions) => options.now().getTime() >= options.deadline;

const hashLength = 32;

const taskHash = (repository: string, number: number) =>
  createHash('sha256').update(`${repository}#${number}`).digest('hex').slice(0, hashLength);

const mergedPullRequest = (
  repository: string,
  listing: MergedPullRequestListing,
): MergedPullRequest => ({
  repository,
  number: listing.number,
  url: listing.url,
  headBranch: listing.headRefName,
  createdAt: listing.createdAt,
  mergedAt: listing.mergedAt,
});

const withMergedUnknown = (
  index: SweepIndex,
  projectRoot: string,
  repository: string | null,
  at: string,
  reason: string,
): SweepIndex => ({
  ...index,
  projects: {
    ...index.projects,
    [projectRoot]: { repository, merged: { status: 'unknown', at, reason } },
  },
});

const advanceEntry = async (
  path: string,
  entry: ResolvedEntry,
  options: ProjectOptions,
): Promise<AdvanceResult> => {
  let state = entry.state;
  let cursor = entry.cursor;
  let done = false;

  while (!done) {
    if (deadlineReached(options)) {
      return { status: 'budget' };
    }

    // oxlint-disable-next-line no-await-in-loop -- Each chunk starts where the previous one ended.
    const chunk = await readTranscriptChunk(path, cursor, chunkSize);

    if (chunk.status === 'missing') {
      return { status: 'removed' };
    }

    if (chunk.status === 'unreadable') {
      return { status: 'unknown', reason: chunk.reason };
    }

    const continued = continueTranscript(state, chunk.text);

    state = {
      ...continued,
      malformedLines: continued.malformedLines + chunk.skippedLines,
      calls: keepFactCalls(continued.calls),
    };

    const next = chunk.nextOffset;

    done = next >= chunk.size || next === cursor;
    cursor = next;
  }

  return { status: 'ok', cursor, state };
};

const readEntry = async (
  path: string,
  entry: ResolvedEntry,
  options: ProjectOptions,
): Promise<
  | { status: 'ok'; entry: SweepIndex['transcripts'][string]; repository?: string | null }
  | { status: 'removed' }
  | { status: 'budget' }
  | { status: 'unknown'; reason: string }
> => {
  let size: number;

  try {
    const facts = await stat(path);

    size = facts.size;
  } catch (error) {
    if (isMissingFile(error)) {
      return { status: 'removed' };
    }

    return { status: 'unknown', reason: errorMessage(error) };
  }

  const decision = decideTranscriptRead({ cursor: entry.cursor, size });

  if (decision === 'unchanged') {
    return { status: 'ok', entry };
  }

  let current: SweepIndex['transcripts'][string] = entry;
  let repository: string | null | undefined;

  if (decision === 'restart') {
    const resolved = await resolveTranscript({
      path,
      exec: options.exec,
      signal: options.signal,
      cache: new Map(),
    });

    current = resolved.entry;
    repository = resolved.status === 'resolved' ? resolved.repository : undefined;
  }

  if (current.status !== 'resolved') {
    return { status: 'ok', entry: current };
  }

  if (current.projectRoot !== options.projectRoot) {
    return {
      status: 'ok',
      entry: current,
      ...(repository === undefined ? {} : { repository }),
    };
  }

  const advanced = await advanceEntry(path, current, options);

  if (advanced.status !== 'ok') {
    return advanced;
  }

  return {
    status: 'ok',
    entry: { ...current, cursor: advanced.cursor, state: advanced.state },
    ...(repository === undefined ? {} : { repository }),
  };
};

const recordMovedTranscript = (
  projects: SweepIndex['projects'],
  entry: SweepIndex['transcripts'][string],
  repository: string | null | undefined,
  currentRoot: string,
) => {
  if (entry.status !== 'resolved' || entry.projectRoot === currentRoot) {
    return;
  }

  const previous = projects[entry.projectRoot];

  projects[entry.projectRoot] = {
    repository: repository ?? previous?.repository ?? null,
    merged: previous?.merged ?? { status: 'notRead' },
  };
};

const readProjectTranscripts = async (
  options: ProjectOptions,
): Promise<
  | { status: 'ok'; transcripts: SweepIndex['transcripts']; projects: SweepIndex['projects'] }
  | { status: 'budget' }
  | { status: 'unknown'; reason: string }
> => {
  const transcripts = { ...options.index.transcripts };
  const projects = { ...options.index.projects };

  const entries = Object.entries(options.index.transcripts).filter(
    ([, entry]) => entry.status === 'resolved' && entry.projectRoot === options.projectRoot,
  );

  for (const [path, entry] of entries) {
    if (entry.status !== 'resolved') {
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- Each transcript is read before the next starts.
    const result = await readEntry(path, entry, options);

    if (result.status === 'budget' || result.status === 'unknown') {
      return result;
    }

    if (result.status === 'removed') {
      // oxlint-disable-next-line typescript/no-dynamic-delete -- The path is the index key.
      delete transcripts[path];

      continue;
    }

    transcripts[path] = result.entry;
    recordMovedTranscript(projects, result.entry, result.repository, options.projectRoot);
  }

  return { status: 'ok', transcripts, projects };
};

const transcriptFacts = (
  transcripts: SweepIndex['transcripts'],
  projectRoot: string,
): TranscriptFact[] =>
  Object.entries(transcripts).flatMap(([path, entry]) =>
    entry.status === 'resolved' && entry.projectRoot === projectRoot
      ? [{ path, transcript: finishTranscript(entry.state) }]
      : [],
  );

const launchedTaskIds = (tasks: ReturnType<typeof mapTasks>['tasks']): Set<string> =>
  new Set(
    tasks.flatMap((task) =>
      task.facts.flatMap((fact) =>
        fact.kind === 'launch' && fact.workerId !== undefined ? [fact.workerId] : [],
      ),
    ),
  );

const writePlannedEvents = async (
  options: ProjectOptions,
  tasks: ReturnType<typeof mapTasks>['tasks'],
  repository: string,
): Promise<{ status: 'ok' } | { status: 'budget' } | { status: 'unknown'; reason: string }> => {
  let read;

  try {
    read = await readEvents(options.projectRoot);
  } catch (error) {
    return { status: 'unknown', reason: errorMessage(error) };
  }

  const gap = read.gaps[0];

  if (gap !== undefined) {
    return { status: 'unknown', reason: gap.reason };
  }

  const existingIds = new Set(read.events.map((event) => event.id));

  const recordedAt = options.now().toISOString();

  const planned = plannedEvents({
    tasks: tasks.map((task) => ({
      task,
      hash: taskHash(repository, task.pullRequest.number),
    })),
    existingIds,
    now: recordedAt,
  });

  for (const event of planned) {
    if (deadlineReached(options)) {
      return { status: 'budget' };
    }

    try {
      // oxlint-disable-next-line no-await-in-loop -- Each event is written before the next starts.
      await writeEvent(options.projectRoot, event);
    } catch (error) {
      return { status: 'unknown', reason: errorMessage(error) };
    }
  }

  return { status: 'ok' };
};

const syncProject = async (options: ProjectOptions): Promise<ProjectSync> => {
  const repository = options.repository;

  if (repository === null) {
    const failedAt = options.now().toISOString();

    return {
      status: 'done',
      index: withMergedUnknown(
        options.index,
        options.projectRoot,
        null,
        failedAt,
        'The project has no origin repository.',
      ),
    };
  }

  let listings: MergedPullRequestListing[];

  try {
    listings = await readMergedPullRequests(
      { exec: options.exec, cwd: options.projectRoot, signal: options.signal },
      parseRepository(repository),
      options.since,
    );
  } catch (error) {
    return options.signal.aborted
      ? { status: 'budget' }
      : { status: 'unknown', reason: errorMessage(error) };
  }

  const read = await readProjectTranscripts(options);

  if (read.status !== 'ok') {
    return read;
  }

  const pullRequests = listings.map((listing) => mergedPullRequest(repository, listing));
  const facts = transcriptFacts(read.transcripts, options.projectRoot);

  const firstMapping = mapTasks({
    pullRequests,
    transcripts: facts,
    repositories: options.repositories,
    workers: new Map(),
  });

  let workers;

  try {
    workers = await readWorkerTranscripts(
      options.agentDirectory,
      launchedTaskIds(firstMapping.tasks),
    );
  } catch (error) {
    return { status: 'unknown', reason: errorMessage(error) };
  }

  const mapping = mapTasks({
    pullRequests,
    transcripts: facts,
    repositories: options.repositories,
    workers,
  });

  const written = await writePlannedEvents(options, mapping.tasks, repository);

  if (written.status !== 'ok') {
    return written;
  }

  const projects = {
    ...read.projects,
    [options.projectRoot]: {
      repository,
      merged: {
        status: 'read' as const,
        at: options.now().toISOString(),
        count: listings.length,
      },
    },
  };

  return {
    status: 'done',
    index: { ...options.index, transcripts: read.transcripts, projects },
  };
};

export const runProject = async (options: ProjectOptions): Promise<ProjectResult> => {
  const result = await syncProject(options);

  if (result.status !== 'unknown') {
    return result;
  }

  const finishedAt = options.now().toISOString();

  return {
    ...result,
    index: withMergedUnknown(
      options.index,
      options.projectRoot,
      options.repository,
      finishedAt,
      result.reason,
    ),
  };
};
