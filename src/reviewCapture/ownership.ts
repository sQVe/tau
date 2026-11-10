import type { CommandRuntime } from '../command.js';
import { errorMessage } from '../errors.js';
import { readGit } from '../git.js';
import { pickPullRequests, readPullRequestList, readViewer } from '../github/github.js';
import { resolveBaseRepository, resolveOptionalHead } from '../github/repositoryTarget.js';
import { decideOwnership } from './ownershipDecision.js';
import type { Ownership } from './ownershipDecision.js';

export interface OwnershipRange {
  base: string | null;
  head: string;
}

export interface OwnershipPullRequest {
  host: string;
  author: { login: string };
}

const readBranchPullRequest = async (
  runtime: CommandRuntime,
): Promise<OwnershipPullRequest | null> => {
  const head = await resolveOptionalHead(runtime);

  if (head === undefined) {
    return null;
  }

  const base = await resolveBaseRepository(runtime, head.repository);
  const listed = await readPullRequestList(runtime, base.repository, head.branch);
  const { pr } = pickPullRequests(listed, head.repository);

  return pr === null ? null : { host: base.repository.host, author: pr.author };
};

const readCommitOwnership = async (runtime: CommandRuntime, range: OwnershipRange) => {
  const email = await readGit(runtime.cwd, ['config', 'user.email']);

  if (email === '') {
    throw new Error('git config user.email is empty. Ownership is unclear.');
  }

  const revisions = range.base === null ? ['-1', range.head] : [`${range.base}..${range.head}`];
  const output = await readGit(runtime.cwd, ['log', '--format=%ae', '-z', ...revisions]);
  const emails = output === '' ? [] : output.split('\0').slice(0, -1);

  return decideOwnership({ kind: 'commits', email, emails });
};

export const readOwnership = async (
  runtime: CommandRuntime,
  range: OwnershipRange,
  pr: OwnershipPullRequest | null,
): Promise<Ownership> => {
  try {
    if (pr !== null) {
      const viewer = await readViewer(runtime, pr);

      return decideOwnership({ kind: 'pr', author: pr.author.login, viewer });
    }

    return await readCommitOwnership(runtime, range);
  } catch (error) {
    return decideOwnership({ kind: 'failed', reason: errorMessage(error) });
  }
};

export const readCaptureOwnership = async (
  runtime: CommandRuntime,
  range: OwnershipRange,
): Promise<Ownership> => {
  try {
    const pr = await readBranchPullRequest(runtime);

    return await readOwnership(runtime, range, pr);
  } catch (error) {
    return decideOwnership({ kind: 'failed', reason: errorMessage(error) });
  }
};
