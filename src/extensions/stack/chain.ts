import type { CommandRuntime } from '../../command.js';
import type { Repository } from '../../github/github.js';
import { formatRepository, sameRepository } from '../../github/repositoryTargetDecisions.js';
import { decideChain, parentIdentity, parsePullRequestUrl, pickParent } from './chainDecisions.js';
import type {
  BlockerFacts,
  ChainDecision,
  ChainFacts,
  ChainTrunk,
  Parent,
  PullRequestReference,
  PullView,
} from './chainDecisions.js';
import { readFailed } from './readResult.js';
import type { Read } from './readResult.js';
import { readBasedOnPulls, readDefaultBranch, readPullView, readStacks } from './reads.js';

export interface ChainRequest {
  pullRequests: readonly string[];
  slicePullRequest: string | undefined;
}

export interface ChainResult {
  repository: string;
  decision: ChainDecision;
  evidence: { blockers: BlockerFacts[]; facts: ChainFacts | null };
}

const parseReference = (url: string): PullRequestReference => {
  const reference = parsePullRequestUrl(url);

  if (reference === undefined) {
    throw new Error(
      `${url} is not a pull request URL such as https://github.com/owner/name/pull/1.`,
    );
  }

  return reference;
};

// Rejects input that is not a list of pull requests in one repository.
const parseRequest = (request: ChainRequest) => {
  const references = request.pullRequests.map(parseReference);
  const [first] = references;

  if (first === undefined) {
    throw new Error('pullRequests needs at least one open blocker pull request URL.');
  }

  const slice =
    request.slicePullRequest === undefined ? undefined : parseReference(request.slicePullRequest);

  for (const reference of [...references, ...(slice === undefined ? [] : [slice])]) {
    if (!sameRepository(first, reference)) {
      throw new Error(
        `Pull request ${reference.number} is not in ${formatRepository(first)}. Pass pull requests of one repository.`,
      );
    }
  }

  const unique = request.pullRequests
    .map((url, index) => ({ url, reference: references[index] ?? first }))
    .filter(
      ({ reference }, index, all) =>
        all.findIndex((earlier) => earlier.reference.number === reference.number) === index,
    );

  const repository: Repository = { host: first.host, owner: first.owner, name: first.name };

  return { repository, blockers: unique, slice: slice?.number ?? null };
};

const readBlocker = async (
  runtime: CommandRuntime,
  repository: Repository,
  { reference, url }: { reference: PullRequestReference; url: string },
): Promise<BlockerFacts> => {
  const [view, stacks] = await Promise.all([
    readPullView(runtime, repository, reference.number),
    readStacks(runtime, repository, reference.number),
  ]);

  return { url, number: reference.number, view, stacks };
};

// Reuses the view of a blocker, so a pull request that is both a blocker and a stack end is read once.
const readStackEnds = async (
  runtime: CommandRuntime,
  repository: Repository,
  stack: readonly number[],
  blockers: readonly BlockerFacts[],
): Promise<Read<{ bottom: PullView; top: PullView }>> => {
  const bottomNumber = stack[0];
  const topNumber = stack.at(-1);

  if (bottomNumber === undefined || topNumber === undefined) {
    return readFailed('gh api stacks', 'printed a stack with no pull requests');
  }

  const readView = (number: number) => {
    const blocker = blockers.find((candidate) => candidate.number === number);

    return blocker === undefined ? readPullView(runtime, repository, number) : blocker.view;
  };

  const bottomRead = readView(bottomNumber);
  const topRead = bottomNumber === topNumber ? bottomRead : readView(topNumber);
  const [bottom, top] = await Promise.all([bottomRead, topRead]);

  if (!bottom.ok) {
    return bottom;
  }

  return top.ok ? { ok: true, value: { bottom: bottom.value, top: top.value } } : top;
};

const readTrunk = async (
  runtime: CommandRuntime,
  repository: Repository,
  parent: Parent,
  blockers: readonly BlockerFacts[],
): Promise<ChainTrunk> => {
  const stack = parent.stack;

  if (stack === null) {
    return { kind: 'default', defaultBranch: await readDefaultBranch(runtime, repository) };
  }

  const ends = await readStackEnds(runtime, repository, stack.pullRequests, blockers);

  return { kind: 'stack', stack, ends };
};

// Decides the parent of a stacked slice from its open blockers, then whether the parent already
// has a branch above it and which trunk the new branch starts from.
export const readChain = async (
  runtime: CommandRuntime,
  request: ChainRequest,
): Promise<ChainResult> => {
  const { repository, blockers: parsed, slice } = parseRequest(request);
  const repositoryName = formatRepository(repository);

  const blockers = await Promise.all(
    parsed.map((blocker) => readBlocker(runtime, repository, blocker)),
  );

  const picked = pickParent(blockers);

  if (picked.result === 'stop') {
    return { repository: repositoryName, decision: picked, evidence: { blockers, facts: null } };
  }

  const { parent } = picked;

  const [basedOn, trunk] = await Promise.all([
    readBasedOnPulls(runtime, repository, parent.branch),
    readTrunk(runtime, repository, parent, blockers),
  ]);

  const facts: ChainFacts = {
    parent: parentIdentity(parent),
    slicePullRequest: slice,
    basedOn,
    trunk,
  };

  return {
    repository: repositoryName,
    decision: decideChain(facts),
    evidence: { blockers, facts },
  };
};
