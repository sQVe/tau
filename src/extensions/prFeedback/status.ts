import { Type } from 'typebox';

import type { CommandRuntime } from '../../command.js';
import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { errorMessage } from '../../errors.js';
import { checkOutput, label, parseJson, runOutcome } from '../../github/github.js';
import type { Repository } from '../../github/github.js';
import { formatRepository } from '../../github/repositoryTargetDecisions.js';
import { readReviewBotStatuses } from '../../reviewBots/reviewBots.js';
import { readChecks } from './checks.js';
import { HeadMovedError, readPullRequest, readReviews, readThreads, readViewer } from './github.js';
import type { PullRequest } from './github.js';
import { settleMergeable } from './read.js';
import { decideStatus, recommendStatus } from './statusDecisions.js';
import type { StatusFacts, StatusResult } from './statusDecisions.js';
import { rejectLongThreads, threadsToShow, unresolvedThreads } from './threads.js';

export interface StatusRequest {
  pr: number;
  head: string;
}

interface StatusRuntime extends CommandRuntime {
  location: ConfigLocation;
  ui: ConfigWarnings;
}

const capture = async <Value>(facts: StatusFacts, source: string, read: () => Promise<Value>) => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof HeadMovedError) {
      facts.headMoved = true;
      facts.head = error.head;
    }

    facts.gaps.push(`${source}: ${errorMessage(error)}`);

    return undefined;
  }
};

const metadata = (facts: StatusFacts, pull: PullRequest) => {
  facts.headMoved ||= facts.head !== pull.headRefOid;
  facts.head = pull.headRefOid;
  facts.url = pull.url;
  facts.draft = pull.isDraft;
  facts.state = pull.state;
  facts.mergeable = pull.mergeable;
  facts.mergeStateStatus = pull.mergeStateStatus;
  facts.reviewDecision = pull.reviewDecision;
};

const readThreadCount = async (runtime: CommandRuntime, repository: Repository, pr: number) => {
  const [viewer, threads] = await Promise.all([
    readViewer(runtime, repository),
    readThreads(runtime, repository, pr),
  ]);

  rejectLongThreads(threads);

  const unresolved = unresolvedThreads({ viewer, threads, reviews: [], comments: [] });

  return threadsToShow(unresolved).length;
};

const requiredChecksSchema = Type.Array(Type.Object({ name: Type.String() }));
const pendingChecksExitCode = 8;

const readRequiredCheckNames = async (
  runtime: CommandRuntime,
  repository: Repository,
  pr: number,
): Promise<string[]> => {
  const commandArguments = [
    'pr',
    'checks',
    String(pr),
    '--repo',
    formatRepository(repository),
    '--required',
    '--json',
    'name',
  ];

  const outcome = await runOutcome(runtime, commandArguments);
  const command = label(commandArguments);

  if (outcome.cancelled) {
    throw new Error(`${command} was stopped.`);
  }

  if (![0, 1, pendingChecksExitCode].includes(outcome.exitCode)) {
    throw new Error(`${command} exited with code ${outcome.exitCode}: ${outcome.stderr}`);
  }

  const noRequiredChecks = /^no required checks reported on the '.+' branch$/u.test(
    outcome.stderr.trim(),
  );

  if (outcome.exitCode === 1 && outcome.stdout.trim() === '' && noRequiredChecks) {
    return [];
  }

  const value = parseJson(commandArguments, outcome.stdout);

  checkOutput(commandArguments, requiredChecksSchema, value);

  return value.map((check) => check.name);
};

const readOpen = async (
  runtime: StatusRuntime,
  repository: Repository,
  pull: PullRequest,
  facts: StatusFacts,
) => {
  const [mergeable, threadCount, reviews, checks, bots, requiredCheckNames] = await Promise.all([
    capture(facts, 'mergeability', () => settleMergeable(runtime, repository, pull)),
    capture(facts, 'threads', () => readThreadCount(runtime, repository, facts.pr)),
    capture(facts, 'reviews', () => readReviews(runtime, repository, facts.pr)),
    capture(facts, 'checks', () =>
      readChecks(runtime, repository, { pr: facts.pr, head: facts.expectedHead, trunk: undefined }),
    ),
    capture(facts, 'reviewBots', () =>
      readReviewBotStatuses(runtime, runtime.location, runtime.ui, {
        repository: formatRepository(repository),
        pr: facts.pr,
      }),
    ),
    capture(facts, 'required checks', () => readRequiredCheckNames(runtime, repository, facts.pr)),
  ]);

  facts.mergeable = mergeable ?? facts.mergeable;
  facts.unresolvedThreads = threadCount ?? 0;

  facts.reviews = (reviews ?? []).map((review) => ({
    id: review.id,
    login: review.user?.login ?? null,
    state: review.state,
  }));

  facts.checks = checks?.checks ?? [];
  facts.requiredCheckNames = requiredCheckNames ?? [];
  facts.bots = bots?.bots ?? [];
  facts.gaps.push(...(checks?.gaps ?? []).map((gap) => `checks: ${gap.reason}`));

  const current = await capture(facts, 'final PR read', () =>
    readPullRequest(runtime, repository, facts.pr),
  );

  if (current !== undefined) {
    metadata(facts, current);
  }
};

const readStatus = async (
  runtime: StatusRuntime,
  repository: Repository,
  request: StatusRequest,
) => {
  const facts: StatusFacts = {
    pr: request.pr,
    url: `https://${formatRepository(repository)}/pull/${request.pr}`,
    expectedHead: request.head,
    head: request.head,
    headMoved: false,
    draft: false,
    state: '',
    mergeable: '',
    mergeStateStatus: '',
    reviewDecision: '',
    unresolvedThreads: 0,
    checks: [],
    requiredCheckNames: [],
    reviews: [],
    bots: [],
    gaps: [],
  };

  const pull = await capture(facts, 'PR read', () =>
    readPullRequest(runtime, repository, request.pr),
  );

  if (pull !== undefined) {
    metadata(facts, pull);

    if (pull.state === 'OPEN' && !facts.headMoved) {
      await readOpen(runtime, repository, pull, facts);
    }
  }

  return decideStatus(facts);
};

export const readStatuses = async (
  runtime: StatusRuntime,
  repository: Repository,
  requests: StatusRequest[],
): Promise<{
  prs: StatusResult[];
  recommended: number | null;
  reason: string | null;
  attention: number[];
}> => {
  const prs = await Promise.all(
    requests.map((request) => readStatus(runtime, repository, request)),
  );

  return { prs, ...recommendStatus(prs) };
};
