import { Type } from 'typebox';

import type { CommandRuntime } from '../../command.js';
import { checkOutput, label, readJson, run } from '../../github.js';
import type { Repository } from '../../github.js';
import { readGit } from '../../gitOutput.js';
import { resolveBaseRepository, resolveHead } from '../../repositoryTarget.js';
import { formatRepository } from '../../repositoryTargetDecisions.js';
import {
  pickBaseBranch,
  pickBaseRemote,
  pickPullRequests,
  rejectDefaultBranch,
} from './targetDecisions.js';
import type { PullRequest } from './targetDecisions.js';

export interface TargetRequest {
  remote: string | undefined;
  base: string | undefined;
}

export interface Target {
  host: string;
  repository: string;
  head: { remote: string; repository: string; owner: string; branch: string; sha: string };
  base: { remote: string; branch: string };
  mergeBase: string;
  pr: PullRequest | null;
  closedPrs: PullRequest[];
}

const pullRequestListSchema = Type.Array(
  Type.Object({
    number: Type.Integer(),
    url: Type.String(),
    state: Type.String(),
    title: Type.String(),
    body: Type.String(),
    baseRefName: Type.String(),
    isDraft: Type.Boolean(),
    headRefOid: Type.String(),
    headRepositoryOwner: Type.Object({ login: Type.String() }),
    headRepository: Type.Union([Type.Object({ name: Type.String() }), Type.Null()]),
  }),
);

const pullRequestListLimit = 100;

const pullRequestFields =
  'number,url,state,title,body,baseRefName,isDraft,headRefOid,headRepositoryOwner,headRepository';

// gh pr list prints at most --limit pull requests and does not say when it left some out.
const readPullRequestList = async (
  runtime: CommandRuntime,
  repository: Repository,
  branch: string,
) => {
  const commandArguments = [
    'pr',
    'list',
    '--repo',
    formatRepository(repository),
    '--head',
    branch,
    '--state',
    'all',
    '--limit',
    String(pullRequestListLimit),
    '--json',
    pullRequestFields,
  ];

  const listed = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, pullRequestListSchema, listed);

  if (listed.length >= pullRequestListLimit) {
    throw new Error(
      `${label(commandArguments)} printed ${listed.length} pull requests, the limit, so the list may be incomplete. Check the pull requests for this branch on GitHub.`,
    );
  }

  return listed;
};

// Fetches into the tracking ref itself, since the remote's fetch refspec may leave the base out.
const pinMergeBase = async (cwd: string, remote: string, branch: string) => {
  const trackingRef = `refs/remotes/${remote}/${branch}`;

  await readGit(cwd, ['fetch', '--quiet', remote, `+refs/heads/${branch}:${trackingRef}`]);

  return readGit(cwd, ['merge-base', trackingRef, 'HEAD']);
};

export const readTarget = async (
  runtime: CommandRuntime,
  request: TargetRequest,
): Promise<Target> => {
  const { cwd } = runtime;
  const head = await resolveHead(runtime, request);
  const { host } = head.repository;

  await run(runtime, ['auth', 'status', '--active', '--hostname', host]);

  const base = await resolveBaseRepository(runtime, head.repository);

  rejectDefaultBranch({
    localBranch: head.localBranch,
    pushBranch: head.branch,
    headRepository: head.repository,
    defaultBranch: base.headDefaultBranch,
  });

  const baseRemote = pickBaseRemote(head.remotes, head.remote, base.repository);
  const listed = await readPullRequestList(runtime, base.repository, head.branch);
  const { pr, closedPrs } = pickPullRequests(listed, head.repository);

  const baseBranch = pickBaseBranch({
    pr,
    requestedBase: request.base,
    defaultBranch: base.defaultBranch,
  });

  return {
    host,
    repository: formatRepository(base.repository),
    head: {
      remote: head.remote,
      repository: formatRepository(head.repository),
      owner: head.repository.owner,
      branch: head.branch,
      sha: await readGit(cwd, ['rev-parse', 'HEAD']),
    },
    base: { remote: baseRemote, branch: baseBranch },
    mergeBase: await pinMergeBase(cwd, baseRemote, baseBranch),
    pr,
    closedPrs,
  };
};
