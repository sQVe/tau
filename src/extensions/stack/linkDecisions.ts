import { quoteShellArgument } from '../../shell.js';
import type { PullView } from './chainDecisions.js';
import type { StackedPullRequests, StackView } from './checkDecisions.js';

export interface LinkFacts {
  remote: string;
  pull: PullView;
  view: StackView;
  localPulls: PullView[];
  stacks: StackedPullRequests;
  belowStacks: StackedPullRequests;
  githubPulls: PullView[];
}

export type LinkDecision =
  | { result: 'stop'; reason: string }
  | { result: 'none' }
  | { result: 'command'; command: string }
  | { result: 'linked' };

const stop = (reason: string): LinkDecision => ({ result: 'stop', reason });

const belowTopOffset = -2;

export const linkPulls = (
  pulls: PullView[],
): { openPulls: PullView[]; below: PullView | undefined } => {
  const openPulls = pulls.filter((pull) => pull.state === 'OPEN');
  const below = openPulls.at(belowTopOffset);

  return { openPulls, below };
};

const checkLinked = (
  facts: LinkFacts,
  stack: Extract<StackedPullRequests, { kind: 'stack' }>,
): LinkDecision => {
  if (!stack.pullRequests.includes(facts.pull.number)) {
    return stop('The GitHub stack does not hold this PR.');
  }

  if (stack.pullRequests.at(-1) !== facts.pull.number) {
    return stop('This PR is not the GitHub stack top.');
  }

  let base = facts.view.trunk;

  for (const number of stack.pullRequests) {
    const pull = facts.githubPulls.find((candidate) => candidate.number === number);

    if (pull === undefined) {
      return stop(`No read of GitHub stack PR #${number}.`);
    }

    if (pull.state !== 'OPEN') {
      continue;
    }

    if (pull.baseRefName !== base) {
      return stop(`PR #${number} has base ${pull.baseRefName}, expected ${base}.`);
    }

    base = pull.headRefName;
  }

  return { result: 'linked' };
};

const planLink = (facts: LinkFacts): LinkDecision => {
  const { pull, view, belowStacks } = facts;
  const { openPulls, below } = linkPulls(facts.localPulls);

  if (openPulls.at(-1)?.number !== pull.number) {
    return stop('The local stack PRs do not end with this PR. Refresh the local stack.');
  }

  if (below === undefined) {
    return { result: 'none' };
  }

  const remote = quoteShellArgument(facts.remote);

  if (belowStacks.kind === 'stack') {
    if (belowStacks.pullRequests.at(-1) !== below.number) {
      return stop(`The GitHub stack below has another top PR, not #${below.number}.`);
    }

    const lowerPulls = openPulls.slice(0, -1);
    const offset = belowStacks.pullRequests.length - lowerPulls.length;

    const matchesSuffix = lowerPulls.every(
      (entry, index) => belowStacks.pullRequests[offset + index] === entry.number,
    );

    if (!matchesSuffix) {
      return stop('The lower open local PRs are not a suffix of the GitHub stack below.');
    }

    return {
      result: 'command',
      command: `gh stack link --remote ${remote} ${belowStacks.number} ${pull.number}`,
    };
  }

  const trunk = quoteShellArgument(view.trunk);
  const numbers = openPulls.map((entry) => entry.number).join(' ');

  return {
    result: 'command',
    command: `gh stack link --remote ${remote} --base ${trunk} ${numbers}`,
  };
};

export const decideLink = (facts: LinkFacts): LinkDecision => {
  const { pull, view, stacks, belowStacks } = facts;

  if (!view.branches.some((branch) => branch.name === pull.headRefName)) {
    return stop(`PR #${pull.number}'s branch is in no local stack.`);
  }

  if (view.branches.at(-1)?.name !== pull.headRefName) {
    return stop('This PR is not the local stack top. GitHub only allows linking the top PR.');
  }

  if (pull.state !== 'OPEN') {
    return stop('This PR is not open.');
  }

  if (stacks.kind === 'off' || belowStacks.kind === 'off') {
    return stop('GitHub stacked pull requests are off.');
  }

  if (stacks.kind === 'stack') {
    return checkLinked(facts, stacks);
  }

  return planLink(facts);
};
