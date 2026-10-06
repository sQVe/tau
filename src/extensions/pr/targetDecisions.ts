import type { Repository } from '../../github.js';

export interface Remote {
  name: string;
  // The repository Git fetches from. undefined when the URL names no GitHub repository, such as a
  // local path.
  repository: Repository | undefined;
  // The repository Git pushes to, from remote.<name>.pushurl when set, otherwise the fetch URL.
  pushRepository: Repository | undefined;
}

export interface RepositoryView {
  parent: { owner: string; name: string } | null;
  defaultBranch: string;
}

export interface ViewedRepository {
  repository: Repository;
  view: RepositoryView;
}

export interface BaseRepository {
  repository: Repository;
  defaultBranch: string;
}

export interface HeadFacts {
  branch: string;
  // What `git rev-parse --abbrev-ref @{push}` prints, such as origin/feature.
  pushTarget: string | undefined;
  requestedRemote: string | undefined;
  remotes: readonly Remote[];
  // Remotes with a remote-tracking ref for the local branch name.
  remotesWithBranch: readonly string[];
}

export interface Head {
  remote: string;
  branch: string;
}

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
}

export type PullRequest = Omit<ListedPullRequest, 'headRepositoryOwner'>;

export interface PullRequestChoice {
  pr: PullRequest | null;
  closedPrs: PullRequest[];
}

export interface BaseBranchFacts {
  pr: PullRequest | null;
  requestedBase: string | undefined;
  defaultBranch: string;
}

export const formatRepository = (repository: Repository): string =>
  `${repository.host}/${repository.owner}/${repository.name}`;

// GitHub compares owner and repository names without case.
const sameRepository = (left: Repository, right: Repository): boolean =>
  formatRepository(left).toLowerCase() === formatRepository(right).toLowerCase();

const remoteNames = (remotes: readonly Remote[]) => remotes.map((remote) => remote.name);

const pushHead = (pushTarget: string, remotes: readonly Remote[]): Head | undefined => {
  const remote = remotes.find((candidate) => pushTarget.startsWith(`${candidate.name}/`));

  return remote === undefined
    ? undefined
    : { remote: remote.name, branch: pushTarget.slice(remote.name.length + 1) };
};

// A named remote wins over the push target, since the caller chose it.
export const pickHead = (facts: HeadFacts): Head => {
  const { branch, requestedRemote, remotes } = facts;

  if (requestedRemote !== undefined) {
    if (!remoteNames(remotes).includes(requestedRemote)) {
      throw new Error(`remote ${requestedRemote} is not a Git remote of this checkout.`);
    }

    return { remote: requestedRemote, branch };
  }

  const fromPush = facts.pushTarget === undefined ? undefined : pushHead(facts.pushTarget, remotes);

  if (fromPush !== undefined) {
    return fromPush;
  }

  const [sole, ...others] = facts.remotesWithBranch;

  if (sole === undefined) {
    throw new Error(
      `Branch ${branch} has no push target, and no remote has a branch named ${branch}. Pass remote.`,
    );
  }

  if (others.length > 0) {
    throw new Error(
      `Remotes ${facts.remotesWithBranch.join(', ')} all have a branch named ${branch}. Pass remote.`,
    );
  }

  return { remote: sole, branch };
};

// The remote to fetch the base from: the head remote when the base is its repository, otherwise
// the first remote that points at the base repository.
export const pickBaseRemote = (
  remotes: readonly Remote[],
  head: { remote: string; repository: Repository },
  baseRepository: Repository,
): string => {
  if (sameRepository(head.repository, baseRepository)) {
    return head.remote;
  }

  const remote = remotes.find(
    (candidate) =>
      candidate.repository !== undefined && sameRepository(candidate.repository, baseRepository),
  );

  if (remote === undefined) {
    throw new Error(
      `No Git remote points at ${formatRepository(baseRepository)}, the upstream of ${formatRepository(head.repository)}. Add one.`,
    );
  }

  return remote.name;
};

// A fork's parent lives on the same host as the fork.
export const upstreamRepository = (
  head: Repository,
  view: RepositoryView,
): Repository | undefined =>
  view.parent === null
    ? undefined
    : { host: head.host, owner: view.parent.owner, name: view.parent.name };

// The base repository is a fork's upstream, otherwise the head repository.
export const pickBaseRepository = (
  head: ViewedRepository,
  upstream: ViewedRepository | undefined,
): BaseRepository => {
  const base = upstream ?? head;

  return { repository: base.repository, defaultBranch: base.view.defaultBranch };
};

const withoutOwner = ({ headRepositoryOwner: _owner, ...pr }: ListedPullRequest): PullRequest => pr;

// Keeps the head owner's pull requests, since another owner's fork can use the same branch name.
export const pickPullRequests = (
  listed: readonly ListedPullRequest[],
  headOwner: string,
): PullRequestChoice => {
  const owned = listed
    .filter((pr) => pr.headRepositoryOwner.login.toLowerCase() === headOwner.toLowerCase())
    .map(withoutOwner);

  const open = owned.filter((pr) => pr.state === 'OPEN');
  const closedPrs = owned.filter((pr) => pr.state !== 'OPEN');

  if (open.length > 1) {
    const numbers = open.map((pr) => `#${pr.number}`).join(', ');

    throw new Error(`Pull requests ${numbers} are all open for this branch. Close all but one.`);
  }

  return { pr: open[0] ?? null, closedPrs };
};

export const pickBaseBranch = (facts: BaseBranchFacts): string =>
  facts.pr?.baseRefName ?? facts.requestedBase ?? facts.defaultBranch;
