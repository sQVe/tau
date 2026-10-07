import type { Repository } from '../../github.js';

export interface RemotePush {
  url: string;
  // undefined when the URL names no GitHub repository.
  repository: Repository | undefined;
}

export interface Remote {
  name: string;
  // The repository Git fetches from. undefined when the URL names no GitHub repository, such as a
  // local path.
  repository: Repository | undefined;
  // Every URL `git push <name>` pushes to: each remote.<name>.pushurl when one is set, otherwise
  // each url.
  pushes: readonly RemotePush[];
  // The remote.<name>.fetch values, such as +refs/heads/*:refs/remotes/origin/*.
  fetchRefspecs: readonly string[];
}

// Where Git pushes a branch, as `git for-each-ref` prints it through %(push).
export interface PushTarget {
  remote: string;
  // The remote-tracking ref of the pushed branch, such as refs/remotes/origin/feature.
  trackingRef: string;
  // The ref on the server, which Git prints only when a remote.<name>.push refspec decides it.
  remoteRef: string | undefined;
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
  pushTarget: PushTarget | undefined;
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

export const formatRepository = (repository: Repository): string =>
  `${repository.host}/${repository.owner}/${repository.name}`;

// GitHub compares owner and repository names without case.
const sameRepository = (left: Repository, right: Repository): boolean =>
  formatRepository(left).toLowerCase() === formatRepository(right).toLowerCase();

const remoteNames = (remotes: readonly Remote[]) => remotes.map((remote) => remote.name);

const branchPrefix = 'refs/heads/';

// Maps a ref back through a pattern refspec, split at its wildcards. Git refuses a pattern refspec
// without exactly one wildcard on each side.
const patternSource = (sourceParts: string[], destinationParts: string[], ref: string) => {
  if (sourceParts.length !== 2 || destinationParts.length !== 2) {
    return undefined;
  }

  const [sourcePrefix = '', sourceSuffix = ''] = sourceParts;
  const [prefix = '', suffix = ''] = destinationParts;

  // Git lets the wildcard match nothing, so only an overlapping prefix and suffix rule a ref out.
  const fits = ref.length >= prefix.length + suffix.length;
  const matches = ref.startsWith(prefix) && ref.endsWith(suffix);
  const captured = ref.slice(prefix.length, ref.length - suffix.length);

  return fits && matches ? `${sourcePrefix}${captured}${sourceSuffix}` : undefined;
};

// Maps a ref back through one fetch refspec: the source ref whose fetch writes ref, if any.
const refspecSource = (refspec: string, ref: string): string | undefined => {
  const [source = '', destination] = refspec.replace(/^\+/u, '').split(':', 2);

  if (refspec.startsWith('^') || destination === undefined) {
    return undefined;
  }

  const destinationParts = destination.split('*');

  if (destinationParts.length === 1) {
    return destination === ref ? source : undefined;
  }

  return patternSource(source.split('*'), destinationParts, ref);
};

// Git maps the server branch forward through the fetch refspecs to name the tracking ref, so the
// reverse mapping finds the server branch. Two refspecs can map different branches to one ref.
const serverBranch = (branch: string, target: PushTarget, remote: Remote) => {
  if (target.remoteRef !== undefined) {
    if (!target.remoteRef.startsWith(branchPrefix)) {
      throw new Error(
        `Branch ${branch} pushes to ${target.remoteRef} on ${remote.name}, which is not a branch.`,
      );
    }

    return target.remoteRef.slice(branchPrefix.length);
  }

  const sources = remote.fetchRefspecs
    .map((refspec) => refspecSource(refspec, target.trackingRef))
    .filter((source) => source?.startsWith(branchPrefix) === true)
    .map((source) => (source ?? '').slice(branchPrefix.length));

  const [sole, ...others] = [...new Set(sources)];

  if (sole === undefined) {
    throw new Error(
      `Branch ${branch} pushes to ${target.trackingRef}, which no fetch refspec of ${remote.name} maps from a branch. Pass remote.`,
    );
  }

  if (others.length > 0) {
    throw new Error(
      `Branch ${branch} pushes to ${target.trackingRef}, which the fetch refspecs of ${remote.name} map from several branches: ${[sole, ...others].join(', ')}. Pass remote.`,
    );
  }

  return sole;
};

const pushHead = (branch: string, target: PushTarget, remotes: readonly Remote[]): Head => {
  const remote = remotes.find((candidate) => candidate.name === target.remote);

  if (remote === undefined) {
    throw new Error(
      `Branch ${branch} pushes to remote ${target.remote}, which is not a Git remote of this checkout.`,
    );
  }

  return { remote: remote.name, branch: serverBranch(branch, target, remote) };
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

  if (facts.pushTarget !== undefined) {
    return pushHead(branch, facts.pushTarget, remotes);
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

// git push sends the branch to every push URL, so a head remote must push to one repository.
export const pickPushRepository = (remote: Remote): Repository => {
  const unnamed = remote.pushes.find((push) => push.repository === undefined);

  if (unnamed !== undefined) {
    throw new Error(
      `The push URL of remote ${remote.name}, ${unnamed.url}, does not name a GitHub repository.`,
    );
  }

  const repositories = remote.pushes.flatMap((push) => push.repository ?? []);
  const [first] = repositories;

  if (first === undefined) {
    throw new Error(`Remote ${remote.name} has no push URL.`);
  }

  const distinct = repositories.filter(
    (repository, index) =>
      repositories.findIndex((earlier) => sameRepository(earlier, repository)) === index,
  );

  if (distinct.length > 1) {
    throw new Error(
      `Remote ${remote.name} pushes to several repositories: ${distinct.map(formatRepository).join(', ')}. Keep one push URL for it, or pass another remote.`,
    );
  }

  return first;
};

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

const fromHeadRepository = (pr: ListedPullRequest, head: Repository) => {
  const sameOwner = pr.headRepositoryOwner.login.toLowerCase() === head.owner.toLowerCase();
  const sameName = pr.headRepository?.name.toLowerCase() === head.name.toLowerCase();

  return sameOwner && sameName;
};

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
