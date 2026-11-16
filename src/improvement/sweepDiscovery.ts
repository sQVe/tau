import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Exec } from '../command.ts';
import { errorMessage, isMissingFile } from '../errors.ts';
import { readOriginRepository } from '../github/repositoryTarget.ts';
import { formatRepository } from '../github/repositoryTargetDecisions.ts';
import { findSessionFiles, readTranscriptChunk } from './improvement.ts';
import { findProjectRoot } from './projectRoot.ts';
import type { SweepIndex } from './sweepIndex.ts';
import { continueTranscript, finishTranscript } from './transcript.ts';
import type { TranscriptState } from './transcript.ts';

type TranscriptEntry = SweepIndex['transcripts'][string];

interface TranscriptLocation {
  projectRoot: string;
  repository: string | null;
}

interface LocationRead {
  status: 'resolved';
  location: TranscriptLocation;
}

type LocationResult = LocationRead | { status: 'unresolved'; reason: string };

interface LocationOptions {
  exec: Exec;
  signal: AbortSignal;
  cache: Map<string, Promise<LocationResult>>;
}

export interface ResolveTranscriptOptions extends LocationOptions {
  path: string;
}

export interface ResolvedTranscript {
  status: 'resolved';
  entry: Extract<TranscriptEntry, { status: 'resolved' }>;
  repository: string | null;
}

export interface UnresolvedTranscript {
  status: 'unresolved';
  entry: Extract<TranscriptEntry, { status: 'unresolved' }>;
}

type HeaderRead =
  | { status: 'resolved'; cwd: string }
  | { status: 'unresolved'; cwd: string | null; reason: string };

export interface DiscoveryOptions {
  agentDirectory: string;
  index: SweepIndex;
  exec: Exec;
  signal: AbortSignal;
  now: () => Date;
  deadline: number;
}

export type DiscoveryResult =
  | { status: 'ok'; index: SweepIndex; repositories: ReadonlyMap<string, string> }
  | { status: 'budget'; index: SweepIndex; repositories: ReadonlyMap<string, string> }
  | { status: 'failed'; reason: string };

const emptyTranscriptState: TranscriptState = {
  header: 'pending',
  calls: [],
  malformedLines: 0,
  droppedCallReasons: [],
};

// oxlint-disable-next-line no-magic-numbers -- A 64 KiB read keeps short reads rare without allocating much.
const headerByteLimit = 64 * 1024;

const nearestExistingDirectory = async (cwd: string): Promise<string | undefined> => {
  let current: string | undefined = cwd;

  while (current !== undefined) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each parent is checked before the next.
      const facts = await stat(current);

      return facts.isDirectory() ? current : undefined;
    } catch (error) {
      if (!isMissingFile(error)) {
        return undefined;
      }
    }

    const parent = dirname(current);

    current = parent === current ? undefined : parent;
  }

  return undefined;
};

const readLocation = async (
  cwd: string,
  exec: Exec,
  signal: AbortSignal,
): Promise<LocationResult> => {
  const existingDirectory = await nearestExistingDirectory(cwd);

  if (existingDirectory === undefined) {
    return { status: 'unresolved', reason: `The directory ${cwd} does not exist.` };
  }

  let projectRoot: string;

  try {
    projectRoot = await findProjectRoot(existingDirectory, { signal });
  } catch (error) {
    return { status: 'unresolved', reason: errorMessage(error) };
  }

  try {
    const origin = await readOriginRepository({ exec, cwd: existingDirectory, signal });
    const repository = origin.status === 'named' ? formatRepository(origin.repository) : null;

    return { status: 'resolved', location: { projectRoot, repository } };
  } catch (error) {
    return { status: 'unresolved', reason: errorMessage(error) };
  }
};

const cachedLocation = (cwd: string, options: LocationOptions): Promise<LocationResult> => {
  const cached = options.cache.get(cwd);

  if (cached !== undefined) {
    return cached;
  }

  const read = readLocation(cwd, options.exec, options.signal);

  options.cache.set(cwd, read);

  return read;
};

const transcriptCwd = (state: TranscriptState): HeaderRead => {
  const transcript = finishTranscript(state);

  if (transcript.status === 'read') {
    return { status: 'resolved', cwd: transcript.cwd };
  }

  if (transcript.status === 'malformed') {
    return { status: 'unresolved', cwd: transcript.cwd ?? null, reason: transcript.reason };
  }

  return { status: 'unresolved', cwd: null, reason: 'The session file could not be read.' };
};

export const resolveTranscript = async (
  options: ResolveTranscriptOptions,
): Promise<ResolvedTranscript | UnresolvedTranscript> => {
  const chunk = await readTranscriptChunk(options.path, 0, headerByteLimit);

  if (chunk.status !== 'read') {
    return {
      status: 'unresolved',
      entry: {
        status: 'unresolved',
        cwd: null,
        reason: chunk.status === 'missing' ? 'The session file is missing.' : chunk.reason,
      },
    };
  }

  const header = transcriptCwd(continueTranscript(undefined, chunk.text));

  if (header.status === 'unresolved') {
    return {
      status: 'unresolved',
      entry: { status: 'unresolved', cwd: header.cwd, reason: header.reason },
    };
  }

  const location = await cachedLocation(header.cwd, options);

  if (location.status === 'unresolved') {
    return {
      status: 'unresolved',
      entry: { status: 'unresolved', cwd: header.cwd, reason: location.reason },
    };
  }

  return {
    status: 'resolved',
    entry: {
      status: 'resolved',
      cwd: header.cwd,
      projectRoot: location.location.projectRoot,
      cursor: 0,
      state: emptyTranscriptState,
    },
    repository: location.location.repository,
  };
};

const projectEntry = (
  projects: SweepIndex['projects'],
  projectRoot: string,
  repository: string | null,
) => {
  const previous = projects[projectRoot];

  return {
    repository,
    merged: previous?.merged ?? { status: 'notRead' as const },
  };
};

const repositoriesOf = (index: SweepIndex): Map<string, string> => {
  const repositories = new Map<string, string>();

  for (const entry of Object.values(index.transcripts)) {
    if (entry.status !== 'resolved') {
      continue;
    }

    const repository = index.projects[entry.projectRoot]?.repository;

    if (repository !== null && repository !== undefined) {
      repositories.set(entry.cwd, repository);
    }
  }

  return repositories;
};

const budgetReached = (options: DiscoveryOptions) =>
  options.signal.aborted || options.now().getTime() >= options.deadline;

const refreshNullRepository = async (
  entry: Extract<TranscriptEntry, { status: 'resolved' }>,
  projects: SweepIndex['projects'],
  options: DiscoveryOptions,
  cache: Map<string, Promise<LocationResult>>,
) => {
  const project = projects[entry.projectRoot];

  if (project !== undefined && project.repository !== null) {
    return;
  }

  const location = await cachedLocation(entry.cwd, {
    exec: options.exec,
    signal: options.signal,
    cache,
  });

  if (location.status === 'resolved') {
    projects[entry.projectRoot] = projectEntry(
      projects,
      entry.projectRoot,
      location.location.repository,
    );
  }
};

const discoveredIndex = (
  options: DiscoveryOptions,
  transcripts: SweepIndex['transcripts'],
  projects: SweepIndex['projects'],
): SweepIndex => ({ ...options.index, transcripts, projects });

const budgetResult = (
  options: DiscoveryOptions,
  transcripts: SweepIndex['transcripts'],
  projects: SweepIndex['projects'],
): DiscoveryResult => {
  const index = discoveredIndex(options, transcripts, projects);

  return { status: 'budget', index, repositories: repositoriesOf(index) };
};

const discoverUnresolved = async (
  sessions: readonly string[],
  transcripts: SweepIndex['transcripts'],
  projects: SweepIndex['projects'],
  options: DiscoveryOptions,
  cache: Map<string, Promise<LocationResult>>,
): Promise<DiscoveryResult | undefined> => {
  const unresolved = sessions.filter((path) => transcripts[path]?.status !== 'resolved');

  for (const path of unresolved) {
    if (budgetReached(options)) {
      return budgetResult(options, transcripts, projects);
    }

    // oxlint-disable-next-line no-await-in-loop -- Each transcript is resolved before the next starts.
    const result = await resolveTranscript({
      path,
      exec: options.exec,
      signal: options.signal,
      cache,
    });

    transcripts[path] = result.entry;

    if (result.status === 'resolved') {
      const root = result.entry.projectRoot;

      projects[root] = projectEntry(projects, root, result.repository);
    }

    if (budgetReached(options)) {
      return budgetResult(options, transcripts, projects);
    }
  }

  return undefined;
};

const refreshRepositories = async (
  sessions: readonly string[],
  transcripts: SweepIndex['transcripts'],
  projects: SweepIndex['projects'],
  options: DiscoveryOptions,
  cache: Map<string, Promise<LocationResult>>,
): Promise<DiscoveryResult | undefined> => {
  for (const path of sessions) {
    const entry = transcripts[path];

    if (entry?.status !== 'resolved' || projects[entry.projectRoot]?.repository !== null) {
      continue;
    }

    if (budgetReached(options)) {
      return budgetResult(options, transcripts, projects);
    }

    // oxlint-disable-next-line no-await-in-loop -- Each repository is resolved before the next starts.
    await refreshNullRepository(entry, projects, options, cache);

    if (budgetReached(options)) {
      return budgetResult(options, transcripts, projects);
    }
  }

  return undefined;
};

export const discoverTranscripts = async (options: DiscoveryOptions): Promise<DiscoveryResult> => {
  let sessions: string[];

  try {
    const files = await findSessionFiles(options.agentDirectory);

    sessions = files.managerSessions;
  } catch (error) {
    return { status: 'failed', reason: errorMessage(error) };
  }

  const transcripts = { ...options.index.transcripts };
  const projects = { ...options.index.projects };
  const cache = new Map<string, Promise<LocationResult>>();

  const unresolved = await discoverUnresolved(sessions, transcripts, projects, options, cache);

  if (unresolved !== undefined) {
    return unresolved;
  }

  const refreshed = await refreshRepositories(sessions, transcripts, projects, options, cache);

  if (refreshed !== undefined) {
    return refreshed;
  }

  const index = discoveredIndex(options, transcripts, projects);

  return { status: 'ok', index, repositories: repositoriesOf(index) };
};
