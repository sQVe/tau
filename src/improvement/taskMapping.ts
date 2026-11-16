import { basename } from 'node:path';

import {
  countTaskFacts,
  extractTaskEvidence,
  namedPullRequest,
  publicationOf,
} from './taskFacts.ts';
import type { MissingEvidence, TaskCounts, TaskFact } from './taskFacts.ts';
import { text } from './transcript.ts';
import type { ToolCall, Transcript } from './transcript.ts';

export interface MergedPullRequest {
  repository: string;
  number: number;
  headBranch: string;
  // ISO time the pull request was opened. Earlier calls naming its number belong to another PR.
  createdAt: string;
}

export interface TranscriptFact {
  path: string;
  transcript: Transcript;
}

export type WorkerTranscript = 'readable' | 'missing' | 'unreadable';

export interface MappingFacts {
  pullRequests: readonly MergedPullRequest[];
  transcripts: readonly TranscriptFact[];
  // The repository of each transcript cwd, as <host>/<owner>/<name>.
  repositories: ReadonlyMap<string, string>;
  // The transcript of each launched worker, by task or assignment ID.
  workers: ReadonlyMap<string, WorkerTranscript>;
}

export type Coverage = 'complete' | 'managerOnly' | 'missing' | 'unknown';

export interface CoverageFacts {
  mapped: boolean;
  malformed: boolean;
  // One item per launched worker; unknownId when the launch names no worker.
  workers: readonly (WorkerTranscript | 'unknownId')[];
}

interface Publication {
  path: string;
  entryId: string;
  timestamp: string;
}

interface Task {
  pullRequest: MergedPullRequest;
  transcripts: string[];
  publication: Publication | undefined;
  facts: TaskFact[];
  missing: MissingEvidence[];
  counts: TaskCounts;
  coverage: Coverage;
}

export interface TaskMapping {
  tasks: Task[];
  // Transcripts without a cwd, which no pull request can map to.
  unattributed: string[];
}

interface AttributedCall {
  call: ToolCall;
  key: string | undefined;
}

interface AttributedTranscript {
  path: string;
  malformed: boolean;
  repository: string;
  folder: string;
  published: Set<string>;
  calls: AttributedCall[];
}

interface TaskSource {
  transcript: AttributedTranscript;
  calls: ToolCall[];
}

const pullRequestKey = (repository: string, pr: number) => `${repository}#${pr}`;

const ticketPattern = /^([a-z]+-\d+)(?:-|$)/i;

const ticketIdOf = (branch: string) => ticketPattern.exec(branch)?.[1]?.toLowerCase();

const folderOf = (cwd: string) => basename(cwd).toLowerCase();

export const decideCoverage = (facts: CoverageFacts): Coverage => {
  const workerReadFailed = facts.workers.includes('unreadable');

  if (facts.malformed || workerReadFailed) {
    return 'unknown';
  }

  if (!facts.mapped) {
    return 'missing';
  }

  const everyWorkerReadable = facts.workers.every((worker) => worker === 'readable');

  return everyWorkerReadable ? 'complete' : 'managerOnly';
};

const namedKey = (call: ToolCall, repository: string) => {
  const pr = namedPullRequest(call);
  const named = text(call.arguments?.repository) ?? repository;

  return pr === undefined ? undefined : pullRequestKey(named, pr);
};

// A renamed repository can reuse a key, so a call naming a pull request before that pull request
// was created belongs to an older one.
const namesOlderPullRequest = (
  call: ToolCall,
  repository: string,
  createdTimes: ReadonlyMap<string, number>,
) => {
  const created = createdTimes.get(namedKey(call, repository) ?? '');

  return created !== undefined && Date.parse(call.timestamp) < created;
};

// A call naming a pull request goes to it. Any other call goes to the next publication after it,
// or to the last publication when none follows.
const attributeCalls = (
  transcriptCalls: readonly ToolCall[],
  repository: string,
  createdTimes: ReadonlyMap<string, number>,
) => {
  const calls = transcriptCalls.filter(
    (call) => !namesOlderPullRequest(call, repository, createdTimes),
  );

  const publications = calls.flatMap((call, index) => {
    const publication = publicationOf(call);

    return publication === undefined
      ? []
      : [{ index, key: pullRequestKey(publication.repository, publication.pr) }];
  });

  const attributed = calls.map((call, index) => {
    const next = publications.find((publication) => publication.index >= index);
    const key = namedKey(call, repository) ?? (next ?? publications.at(-1))?.key;

    return { call, key };
  });

  return { published: new Set(publications.map(({ key }) => key)), calls: attributed };
};

const attributeTranscript = (
  fact: TranscriptFact,
  repositories: ReadonlyMap<string, string>,
  createdTimes: ReadonlyMap<string, number>,
): AttributedTranscript | undefined => {
  const { transcript } = fact;
  const cwd = 'cwd' in transcript ? transcript.cwd : undefined;
  const repository = cwd === undefined ? undefined : repositories.get(cwd);

  if (cwd === undefined || repository === undefined || !('calls' in transcript)) {
    return undefined;
  }

  return {
    path: fact.path,
    malformed: transcript.status === 'malformed',
    repository,
    folder: folderOf(cwd),
    ...attributeCalls(transcript.calls, repository, createdTimes),
  };
};

const publishedSources = (key: string, transcripts: readonly AttributedTranscript[]) =>
  transcripts.flatMap((transcript) => {
    const calls = transcript.calls.filter((item) => item.key === key).map(({ call }) => call);

    return calls.length === 0 ? [] : [{ transcript, calls }];
  });

const fallbackSources = (
  pullRequest: MergedPullRequest,
  key: string,
  transcripts: readonly AttributedTranscript[],
) => {
  const ticketId = ticketIdOf(pullRequest.headBranch);

  return transcripts
    .filter((transcript) => transcript.published.size === 0 && transcript.folder === ticketId)
    .map((transcript) => ({
      transcript,
      calls: transcript.calls
        .filter((item) => item.key === undefined || item.key === key)
        .map(({ call }) => call),
    }));
};

const sourcesOf = (
  pullRequest: MergedPullRequest,
  transcripts: readonly AttributedTranscript[],
) => {
  const key = pullRequestKey(pullRequest.repository, pullRequest.number);
  const inRepository = transcripts.filter((item) => item.repository === pullRequest.repository);
  const isPublished = inRepository.some((transcript) => transcript.published.has(key));

  return isPublished
    ? publishedSources(key, inRepository)
    : fallbackSources(pullRequest, key, inRepository);
};

// Forked sessions copy entries, so each call counts once across transcripts. A copy cut before
// its result must not hide the result of another copy.
const combinedCalls = (sources: readonly TaskSource[]) => {
  const calls = new Map<string, ToolCall>();

  for (const call of sources.flatMap((source) => source.calls)) {
    const key = `${call.entryId}\0${call.callId}`;

    if (calls.get(key)?.result === undefined) {
      calls.set(key, call);
    }
  }

  return [...calls.values()].toSorted((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
};

const latestPublication = (key: string, sources: readonly TaskSource[]) => {
  const publications = sources.flatMap(({ transcript, calls }) =>
    calls
      .filter((call) => {
        const publication = publicationOf(call);

        return (
          publication !== undefined &&
          pullRequestKey(publication.repository, publication.pr) === key
        );
      })
      .map((call) => ({ path: transcript.path, entryId: call.entryId, timestamp: call.timestamp })),
  );

  return publications
    .toSorted((left, right) => left.timestamp.localeCompare(right.timestamp))
    .at(-1);
};

const launchedWorkers = (facts: readonly TaskFact[], workers: MappingFacts['workers']) =>
  facts.flatMap((fact) => {
    if (fact.kind !== 'launch') {
      return [];
    }

    return fact.workerId === undefined
      ? ['unknownId' as const]
      : [workers.get(fact.workerId) ?? 'missing'];
  });

const buildTask = (
  pullRequest: MergedPullRequest,
  transcripts: readonly AttributedTranscript[],
  workers: MappingFacts['workers'],
): Task => {
  const key = pullRequestKey(pullRequest.repository, pullRequest.number);
  const sources = sourcesOf(pullRequest, transcripts);
  const evidence = extractTaskEvidence(combinedCalls(sources));

  const coverage = decideCoverage({
    mapped: sources.length > 0,
    malformed: sources.some((source) => source.transcript.malformed),
    workers: launchedWorkers(evidence.facts, workers),
  });

  return {
    pullRequest,
    transcripts: sources.map((source) => source.transcript.path),
    publication: latestPublication(key, sources),
    facts: evidence.facts,
    missing: evidence.missing,
    counts: countTaskFacts(evidence),
    coverage,
  };
};

const isUnattributed = (fact: TranscriptFact) =>
  !('cwd' in fact.transcript) || fact.transcript.cwd === undefined;

export const mapTasks = (facts: MappingFacts): TaskMapping => {
  const createdTimes = new Map(
    facts.pullRequests.map((pullRequest) => [
      pullRequestKey(pullRequest.repository, pullRequest.number),
      Date.parse(pullRequest.createdAt),
    ]),
  );

  const transcripts = facts.transcripts.flatMap((fact) => {
    const attributed = attributeTranscript(fact, facts.repositories, createdTimes);

    return attributed === undefined ? [] : [attributed];
  });

  return {
    tasks: facts.pullRequests.map((pullRequest) =>
      buildTask(pullRequest, transcripts, facts.workers),
    ),
    unattributed: facts.transcripts.filter(isUnattributed).map((fact) => fact.path),
  };
};
