import type { StackedPullRequests } from './checkDecisions.js';
import { describeFailures, failures } from './readResult.js';
import type { Read } from './readResult.js';

export interface PullRequestReference {
  host: string;
  owner: string;
  name: string;
  number: number;
}

export interface PullView {
  number: number;
  headRefName: string;
  baseRefName: string;
  state: string;
}

export interface BlockerFacts {
  url: string;
  number: number;
  view: Read<PullView>;
  stacks: Read<StackedPullRequests>;
}

interface GithubStack {
  number: number;
  // Bottom to top.
  pullRequests: number[];
}

export interface Parent {
  number: number;
  url: string;
  branch: string;
  // The pull requests of the GitHub stack that holds the parent, bottom to top, or null.
  stack: GithubStack | null;
}

export type ParentDecision =
  | { result: 'stop'; reason: string }
  | { result: 'parent'; parent: Parent };

export interface ChainFacts {
  parent: Parent;
  // The pull request of the slice being started, which does not count as a branch above.
  slicePullRequest: number | null;
  // Open pull requests based on the parent's branch.
  basedOn: Read<{ number: number; headRefName: string }[]>;
  // The lowest and highest pull requests of the parent's stack. null when no stack holds it.
  stackEnds: Read<{ bottom: PullView; top: PullView }> | null;
  defaultBranch: Read<string>;
}

export type ChainDecision =
  | { result: 'stop'; reason: string }
  | {
      result: 'parent';
      parent: { number: number; url: string; branch: string };
      // An open pull request other than the slice's, or the parent's stack, has a branch above the parent.
      branchAbove: boolean;
      // The pull requests above the parent, from its stack and from pull requests based on it.
      above: number[];
      githubStack: {
        number: number;
        pullRequests: number[];
        topBranch: string;
        topPullRequest: number;
      } | null;
      trunk: string;
    };

// https://<host>/<owner>/<name>/pull/<number>, with an optional trailing path.
export const parsePullRequestUrl = (url: string): PullRequestReference | undefined => {
  const match = /^https:\/\/([^/\s]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/u.exec(
    url.trim(),
  );

  if (match === null) {
    return undefined;
  }

  const [, host = '', owner = '', name = '', number = ''] = match;

  return { host, owner, name, number: Number(number) };
};

const describeNumbers = (numbers: readonly number[]) =>
  numbers.map((number) => `#${number}`).join(', ');

const stop = (reason: string): { result: 'stop'; reason: string } => ({ result: 'stop', reason });

const stackOf = (blocker: BlockerFacts): GithubStack | null => {
  const stacks = blocker.stacks;

  if (!stacks.ok || stacks.value.kind !== 'stack') {
    return null;
  }

  return { number: stacks.value.number, pullRequests: stacks.value.pullRequests };
};

// Keeps the blockers that are open. A failed read or a closed blocker gives the reason to stop.
const openBlockers = (blockers: readonly BlockerFacts[]): Parent[] | string => {
  const failed = failures(blockers.flatMap((blocker) => [blocker.view, blocker.stacks]));

  if (failed.length > 0) {
    return describeFailures(failed);
  }

  const open: Parent[] = [];
  const closed: number[] = [];

  for (const blocker of blockers) {
    const view = blocker.view.ok ? blocker.view.value : undefined;

    if (view?.state === 'OPEN') {
      open.push({
        number: blocker.number,
        url: blocker.url,
        branch: view.headRefName,
        stack: stackOf(blocker),
      });
    }

    if (view !== undefined && view.state !== 'OPEN') {
      closed.push(blocker.number);
    }
  }

  return closed.length > 0 ? `Blockers ${describeNumbers(closed)} are not open.` : open;
};

const holdsAll = (stack: readonly number[], blockers: readonly Parent[]) =>
  blockers.every((blocker) => stack.includes(blocker.number));

const highestIn = (stack: readonly number[], blockers: readonly Parent[]) =>
  blockers.reduce((highest, blocker) =>
    stack.indexOf(blocker.number) > stack.indexOf(highest.number) ? blocker : highest,
  );

const pickFromOpen = (open: readonly Parent[]): ParentDecision => {
  const [first] = open;

  if (first === undefined) {
    return stop('No open blocker pull request was given.');
  }

  if (open.length === 1) {
    return { result: 'parent', parent: first };
  }

  const numbers = describeNumbers(open.map((blocker) => blocker.number));

  if (open.every((blocker) => blocker.stack === null)) {
    return stop(`Blockers ${numbers} are open and no GitHub stack holds them.`);
  }

  const stack = first.stack;

  if (stack === null || !holdsAll(stack.pullRequests, open)) {
    return stop(`Blockers ${numbers} sit in different GitHub stacks, or not all in one.`);
  }

  return { result: 'parent', parent: { ...highestIn(stack.pullRequests, open), stack } };
};

// Open blockers are in one chain when one GitHub stack holds them all, or when only one is open.
// The parent is the open blocker highest in that stack.
export const pickParent = (blockers: readonly BlockerFacts[]): ParentDecision => {
  const open = openBlockers(blockers);

  return typeof open === 'string' ? stop(open) : pickFromOpen(open);
};

const parentSummary = ({ number, url, branch }: Parent) => ({ number, url, branch });

const decideWithoutStack = (
  facts: ChainFacts,
  defaultBranch: string,
  above: number[],
): ChainDecision => {
  const { parent } = facts;

  if (above.length > 0) {
    return stop(
      `Pull requests ${describeNumbers(above)} are based on ${parent.branch} and no GitHub stack holds #${parent.number}.`,
    );
  }

  return {
    result: 'parent',
    parent: parentSummary(parent),
    branchAbove: false,
    above,
    githubStack: null,
    trunk: defaultBranch,
  };
};

const decideWithStack = (
  parent: Parent,
  stack: GithubStack,
  ends: { bottom: PullView; top: PullView },
  above: number[],
): ChainDecision => ({
  result: 'parent',
  parent: parentSummary(parent),
  branchAbove: above.length > 0,
  above,
  githubStack: {
    number: stack.number,
    pullRequests: [...stack.pullRequests],
    topBranch: ends.top.headRefName,
    topPullRequest: ends.top.number,
  },
  trunk: ends.bottom.baseRefName,
});

// The pull requests above the parent: those after it in its stack and those based on its branch.
// The slice's own pull request is not above the parent.
const pullsAbove = (facts: ChainFacts, basedOn: readonly number[]): number[] | undefined => {
  const { parent, slicePullRequest } = facts;
  const pullRequests = parent.stack?.pullRequests;
  const position = pullRequests?.indexOf(parent.number) ?? -1;

  if (parent.stack !== null && position === -1) {
    return undefined;
  }

  const inStack = pullRequests?.slice(position + 1) ?? [];

  return [...new Set([...inStack, ...basedOn])].filter((number) => number !== slicePullRequest);
};

// The part of the chain rule that needs the parent: whether it already has a branch above it, and
// the trunk to create the new branch from.
export const decideChain = (facts: ChainFacts): ChainDecision => {
  const failed = failures([facts.basedOn, facts.stackEnds, facts.defaultBranch]);

  if (failed.length > 0) {
    return stop(describeFailures(failed));
  }

  const basedOn = facts.basedOn.ok ? facts.basedOn.value.map((pull) => pull.number) : [];
  const defaultBranch = facts.defaultBranch.ok ? facts.defaultBranch.value : '';
  const above = pullsAbove(facts, basedOn);
  const { parent } = facts;

  if (above === undefined || parent.stack === null) {
    return above === undefined
      ? stop(`The GitHub stack of #${parent.number} does not list it.`)
      : decideWithoutStack(facts, defaultBranch, above);
  }

  const ends = facts.stackEnds?.ok === true ? facts.stackEnds.value : undefined;

  if (ends === undefined) {
    return stop('The ends of the GitHub stack were not read.');
  }

  return decideWithStack(parent, parent.stack, ends, above);
};
