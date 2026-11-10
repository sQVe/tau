import type { Repository } from './github.js';
import { fromHeadRepository } from './repositoryTargetDecisions.js';

export interface ListedPullRequest {
  number: number;
  url: string;
  state: string;
  title: string;
  body: string;
  author: { login: string };
  baseRefName: string;
  isDraft: boolean;
  headRefOid: string;
  headRepositoryOwner: { login: string };
  // null when GitHub no longer has the head repository, such as a deleted fork.
  headRepository: { name: string } | null;
}

export type PullRequest = Omit<ListedPullRequest, 'headRepositoryOwner' | 'headRepository'>;

export interface PullRequestChoice {
  pr: PullRequest | null;
  closedPrs: PullRequest[];
}

const withoutHead = ({
  headRepositoryOwner: _owner,
  headRepository: _repository,
  ...pr
}: ListedPullRequest): PullRequest => pr;

// Keeps the head repository's pull requests, since another fork, or another repository of the
// same owner, can use the same branch name.
export const pickPullRequests = (
  listed: readonly ListedPullRequest[],
  headRepository: Repository,
): PullRequestChoice => {
  const owned = listed.filter((pr) => fromHeadRepository(pr, headRepository)).map(withoutHead);

  const open = owned.filter((pr) => pr.state === 'OPEN');
  const closedPrs = owned.filter((pr) => pr.state !== 'OPEN');

  if (open.length > 1) {
    const numbers = open.map((pr) => `#${pr.number}`).join(', ');

    throw new Error(`Pull requests ${numbers} are all open for this branch. Close all but one.`);
  }

  return { pr: open[0] ?? null, closedPrs };
};
