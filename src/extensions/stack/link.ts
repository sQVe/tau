import type { CommandRuntime } from '../../command.js';
import type { Repository } from '../../github/github.js';
import { resolveBaseRepository, resolveHead } from '../../github/repositoryTarget.js';
import type { PullView } from './chainDecisions.js';
import { requireStackView } from './checkDecisions.js';
import type { StackView } from './checkDecisions.js';
import { decideLink, linkPulls } from './linkDecisions.js';
import type { LinkDecision, LinkFacts } from './linkDecisions.js';
import { readFailed, readOk } from './readResult.js';
import type { Read } from './readResult.js';
import { readPullView, readStacks, readStackViewFacts } from './reads.js';

export interface LinkRequest {
  pr: number;
  remote: string;
}

type LinkResult = LinkDecision & { evidence: Record<string, unknown> };

const readPulls = async (
  runtime: CommandRuntime,
  repository: Repository,
  references: (number | string)[],
): Promise<Read<PullView[]>> => {
  const reads = await Promise.all(
    references.map((reference) => readPullView(runtime, repository, reference)),
  );

  const pulls: PullView[] = [];

  for (const read of reads) {
    if (!read.ok) {
      return read;
    }

    pulls.push(read.value);
  }

  return readOk(pulls);
};

const readGithubFacts = async (
  runtime: CommandRuntime,
  repository: Repository,
  local: Pick<LinkFacts, 'remote' | 'pull' | 'view' | 'localPulls'>,
): Promise<Read<LinkFacts>> => {
  const stacks = await readStacks(runtime, repository, local.pull.number);

  if (!stacks.ok) {
    return stacks;
  }

  const { below } = linkPulls(local.localPulls);

  const belowStacks =
    below === undefined
      ? readOk({ kind: 'none' } as const)
      : await readStacks(runtime, repository, below.number);

  if (!belowStacks.ok) {
    return belowStacks;
  }

  const numbers = stacks.value.kind === 'stack' ? stacks.value.pullRequests : [];
  const githubPulls = await readPulls(runtime, repository, numbers);

  if (!githubPulls.ok) {
    return githubPulls;
  }

  return readOk({
    ...local,
    stacks: stacks.value,
    belowStacks: belowStacks.value,
    githubPulls: githubPulls.value,
  });
};

const readLinkFacts = async (
  runtime: CommandRuntime,
  request: LinkRequest,
  view: StackView,
): Promise<Read<LinkFacts>> => {
  let repository: Repository;

  try {
    const head = await resolveHead(runtime, { remote: request.remote });
    const base = await resolveBaseRepository(runtime, head.repository);

    repository = base.repository;
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);

    return readFailed('resolve the push repository and the base repository', problem);
  }

  const pull = await readPullView(runtime, repository, request.pr);

  if (!pull.ok) {
    return pull;
  }

  const references = view.branches
    .filter((branch) => !branch.isMerged)
    .map((branch) => branch.pr?.number ?? branch.name);

  const localPulls = await readPulls(runtime, repository, references);

  if (!localPulls.ok) {
    return localPulls;
  }

  return readGithubFacts(runtime, repository, {
    remote: request.remote,
    pull: pull.value,
    view,
    localPulls: localPulls.value,
  });
};

export const readLink = async (
  runtime: CommandRuntime,
  request: LinkRequest,
): Promise<LinkResult> => {
  const stackView = await readStackViewFacts(runtime);
  const evidence: Record<string, unknown> = { stackView };

  const view = requireStackView(stackView);

  if (!view.ok) {
    return {
      result: 'stop',
      reason: `${view.command} ${view.problem}`,
      evidence,
    };
  }

  const facts = await readLinkFacts(runtime, request, view.value);

  evidence.facts = facts;

  if (!facts.ok) {
    return { result: 'stop', reason: `${facts.command} ${facts.problem}`, evidence };
  }

  return { ...decideLink(facts.value), evidence };
};
