import type { Repository } from '../../github/github.js';
import {
  formatRepository,
  fromHeadRepository,
  sameRepository,
} from '../../github/repositoryTargetDecisions.js';
import type { Remote } from '../../github/repositoryTargetDecisions.js';

export interface ListedPullRequest {
  number: number;
  url: string;
  state: string;
  title: string;
  body: string;
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

export interface DefaultBranchFacts {
  localBranch: string;
  // The branch on the head remote that the local branch pushes to.
  pushBranch: string;
  headRepository: Repository;
  // The default branch of the head repository, which may differ from its upstream's.
  defaultBranch: string;
}

export interface BaseBranchFacts {
  pr: PullRequest | null;
  requestedBase: string | undefined;
  defaultBranch: string;
}

const fetchesFrom = (remote: Remote, repository: Repository) =>
  remote.repository !== undefined && sameRepository(remote.repository, repository);

// The remote to fetch the base from, chosen by fetch repository only, since a remote can push to
// one repository and fetch from another: the head remote when it fetches the base repository,
// otherwise the first remote that does.
export const pickBaseRemote = (
  remotes: readonly Remote[],
  headRemote: string,
  baseRepository: Repository,
): string => {
  const head = remotes.find((remote) => remote.name === headRemote);
  const headFetchesBase = head !== undefined && fetchesFrom(head, baseRepository);

  const remote = headFetchesBase
    ? head
    : remotes.find((candidate) => fetchesFrom(candidate, baseRepository));

  if (remote === undefined) {
    throw new Error(`No Git remote fetches from ${formatRepository(baseRepository)}. Add one.`);
  }

  return remote.name;
};

export const rejectDefaultBranch = (facts: DefaultBranchFacts): void => {
  const repository = formatRepository(facts.headRepository);

  if (facts.localBranch === facts.defaultBranch) {
    throw new Error(
      `${facts.localBranch} is the default branch of ${repository}. Check out a feature branch.`,
    );
  }

  if (facts.pushBranch === facts.defaultBranch) {
    throw new Error(
      `${facts.localBranch} pushes to ${facts.pushBranch}, the default branch of ${repository}. Push to a feature branch.`,
    );
  }
};

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

// A requested base wins over an open pull request's base, so a caller can move the pull request
// onto a new parent, such as its parent in a stack.
export const pickBaseBranch = (facts: BaseBranchFacts): string =>
  facts.requestedBase ?? facts.pr?.baseRefName ?? facts.defaultBranch;
