import type { Repository, Runtime } from '../../github.js';
import { sameRepository } from '../../repositoryTargetDecisions.js';
import { decideChain, parsePullRequestUrl, pickParent } from './chainDecisions.js';
import type {
  BlockerFacts,
  ChainDecision,
  ChainFacts,
  ParentDecision,
  PullRequestReference,
} from './chainDecisions.js';
import { readFailed } from './readResult.js';
import { readBasedOnPulls, readDefaultBranch, readPullView, readStacks } from './reads.js';

export interface ChainRequest {
  pullRequests: readonly string[];
  slicePullRequest: string | undefined;
}

export interface ChainResult {
  repository: string;
  decision: ChainDecision | ParentDecision;
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
        `Pull request ${reference.number} is not in ${first.host}/${first.owner}/${first.name}. Pass pull requests of one repository.`,
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
  runtime: Runtime,
  repository: Repository,
  { reference, url }: { reference: PullRequestReference; url: string },
): Promise<BlockerFacts> => {
  const [view, stacks] = await Promise.all([
    readPullView(runtime, repository, reference.number),
    readStacks(runtime, repository, reference.number),
  ]);

  return { url, number: reference.number, view, stacks };
};

const readStackEnds = async (
  runtime: Runtime,
  repository: Repository,
  stack: readonly number[],
): Promise<ChainFacts['stackEnds']> => {
  const bottomNumber = stack[0];
  const topNumber = stack.at(-1);

  if (bottomNumber === undefined || topNumber === undefined) {
    return readFailed('gh api stacks', 'printed a stack with no pull requests');
  }

  const [bottom, top] = await Promise.all([
    readPullView(runtime, repository, bottomNumber),
    readPullView(runtime, repository, topNumber),
  ]);

  if (!bottom.ok) {
    return bottom;
  }

  return top.ok ? { ok: true, value: { bottom: bottom.value, top: top.value } } : top;
};

// Decides the parent of a stacked slice from its open blockers, then whether the parent already
// has a branch above it and which trunk the new branch starts from.
export const readChain = async (runtime: Runtime, request: ChainRequest): Promise<ChainResult> => {
  const { repository, blockers: parsed, slice } = parseRequest(request);
  const repositoryName = `${repository.host}/${repository.owner}/${repository.name}`;

  const blockers = await Promise.all(
    parsed.map((blocker) => readBlocker(runtime, repository, blocker)),
  );

  const picked = pickParent(blockers);

  if (picked.result === 'stop') {
    return { repository: repositoryName, decision: picked, evidence: { blockers, facts: null } };
  }

  const { parent } = picked;

  const [basedOn, stackEnds, defaultBranch] = await Promise.all([
    readBasedOnPulls(runtime, repository, parent.branch),
    parent.stack === null ? null : readStackEnds(runtime, repository, parent.stack.pullRequests),
    readDefaultBranch(runtime, repository),
  ]);

  const facts: ChainFacts = { parent, slicePullRequest: slice, basedOn, stackEnds, defaultBranch };

  return {
    repository: repositoryName,
    decision: decideChain(facts),
    evidence: { blockers, facts },
  };
};
