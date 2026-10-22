import type { Repository } from '../../github/github.js';
import { fromHeadRepository } from '../../github/repositoryTargetDecisions.js';
import type { ListedHead } from '../../github/repositoryTargetDecisions.js';
import { isRecord } from '../../schema.js';
import { describeFailures, failedExit, failures, malformedOutput, readOk } from './readResult.js';
import type { CommandOutput, Read } from './readResult.js';

export interface StackLayer {
  name: string;
  base: string;
  isCurrent: boolean;
  isMerged: boolean;
  isQueued: boolean;
  needsRebase: boolean;
  pr?: { number: number; url: string; state: string } | null;
}

// `gh stack view --json`, with branches ordered bottom to top.
export interface StackView {
  trunk: string;
  currentBranch: string;
  branches: StackLayer[];
}

export type StackedPullRequests =
  | { kind: 'off' }
  | { kind: 'none' }
  // Pull request numbers, bottom to top.
  | { kind: 'stack'; number: number; pullRequests: number[] };

export interface HeadPull extends ListedHead {
  number: number;
  url: string;
  baseRefName: string;
}

export interface BasedPull {
  number: number;
  url: string;
  headRefName: string;
}

export interface CurrentBranchFacts {
  // $(git rev-parse --git-dir)/gh-stack-rebase-state exists.
  rebasePaused: boolean;
  // null when a paused rebase made the read pointless.
  stackView: StackViewRead | null;
}

export interface StackViewRead {
  exitCode: number | null;
  // Parsed output of an exit 0 run. null for any other exit code.
  view: Read<StackView> | null;
}

export type ViewDecision =
  | { result: 'tracked'; trunk: string; parent: string; layers: StackLayer[] }
  | { result: 'unknown'; reason: string }
  | { result: 'github' };

// What the view and a paused rebase decide without GitHub.
export type ViewOutcome = Exclude<ViewDecision, { result: 'github' }>;

export type HeadPullChoice =
  | { kind: 'none' }
  | { kind: 'one'; pull: HeadPull }
  | { kind: 'several'; numbers: number[] };

export interface GithubFacts {
  defaultBranch: string;
  // The repository the branch pushes to, which its pull request's head belongs to.
  pushRepository: Repository;
  // The repository that holds the pull requests, which a base branch lives in.
  baseRepository: Repository;
  headPulls: Read<HeadPull[]>;
  basedOn: Read<BasedPull[]>;
  // null when no pull request holds the branch.
  stacks: Read<StackedPullRequests> | null;
  // null when the base is the default branch or no pull request holds the branch.
  basePulls: Read<HeadPull[]> | null;
}

type HeldReason = 'githubStack' | 'baseHasOpenPull' | 'openPullBasedOnBranch';

export interface ChainLink {
  branch: string;
  number: number;
  url: string;
}

export type GithubDecision =
  | { result: 'standalone' }
  | { result: 'unknown'; reason: string }
  | {
      result: 'untracked';
      held: HeldReason[];
      // Pull requests the reads found, bottom to top. They need not be the whole chain.
      chain: ChainLink[];
      // The open pull requests based on the branch, with the branch each one is from.
      basedOn: ChainLink[];
      // The base of the lowest pull request in the chain.
      chainBase: string | null;
      githubStack: { number: number; pullRequests: number[] } | null;
    };

const stackViewCommand = 'gh stack view --json';

const exitCodeReasons: Readonly<Record<number, string>> = {
  6: 'The branch is in several stacks. Check out a non-trunk branch first, or ask.',
};

const unknownResult = (reason: string): ViewDecision => ({ result: 'unknown', reason });

const nearestUnmergedBelow = (layers: readonly StackLayer[], index: number, trunk: string) =>
  layers.slice(0, index).findLast((layer) => !layer.isMerged)?.name ?? trunk;

const exitReason = (exitCode: number | null) => {
  const known = exitCodeReasons[exitCode ?? -1];

  if (known !== undefined) {
    return known;
  }

  const status = exitCode === null ? 'did not finish' : `exited with code ${exitCode}`;

  return `${stackViewCommand} ${status}.`;
};

const decideTracked = (branch: string, view: Read<StackView> | null): ViewDecision => {
  if (view === null) {
    return unknownResult(`${stackViewCommand} printed no output.`);
  }

  if (!view.ok) {
    return unknownResult(`${stackViewCommand} ${view.problem}`);
  }

  const { trunk, branches } = view.value;
  const index = branches.findIndex((layer) => layer.name === branch);

  if (index === -1) {
    return unknownResult(`${stackViewCommand} lists no branch ${branch}.`);
  }

  const parent = nearestUnmergedBelow(branches, index, trunk);

  return { result: 'tracked', trunk, parent, layers: branches };
};

// The first step of the stack check: what `gh stack view --json` and a paused rebase decide.
// `github` means the stack is not tracked in this worktree, so GitHub must be read.
export const decideStackView = (
  branch: string,
  current: CurrentBranchFacts | null,
): ViewDecision => {
  if (current === null) {
    return { result: 'github' };
  }

  if (current.rebasePaused) {
    return unknownResult(
      'A stack rebase is paused. Finish it with gh stack rebase --continue or abort it.',
    );
  }

  if (current.stackView === null) {
    return unknownResult(`${stackViewCommand} was not read.`);
  }

  const { exitCode, view } = current.stackView;

  if (exitCode === 2) {
    return { result: 'github' };
  }

  return exitCode === 0 ? decideTracked(branch, view) : unknownResult(exitReason(exitCode));
};

const readNumbered = (value: unknown): number | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const { number } = value;

  return typeof number === 'number' && Number.isInteger(number) ? number : undefined;
};

// The stacks API read prints the raw reply: an empty list when no stack holds the pull request, or
// a list that starts with the stack, {number, pull_requests: [{number}]}, its pull requests bottom
// to top. The API answers 404 when the repository has no stacked pull requests.
export const readStacksResponse = (
  command: string,
  output: CommandOutput,
): Read<StackedPullRequests> => {
  if (output.exitCode === null) {
    return failedExit(command, output);
  }

  if (output.exitCode !== 0) {
    const notFound = /HTTP 404/u.test(`${output.stderr}\n${output.stdout}`);

    return notFound ? readOk({ kind: 'off' }) : failedExit(command, output);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    return malformedOutput(command, output);
  }

  if (!Array.isArray(parsed)) {
    return malformedOutput(command, output);
  }

  if (parsed.length === 0) {
    return readOk({ kind: 'none' });
  }

  const stack: unknown = parsed[0];
  const number = readNumbered(stack);
  const listed = isRecord(stack) ? stack.pull_requests : undefined;

  if (number === undefined || !Array.isArray(listed)) {
    return malformedOutput(command, output);
  }

  const pullRequests = listed.map(readNumbered);

  if (!pullRequests.every((entry) => entry !== undefined)) {
    return malformedOutput(command, output);
  }

  return readOk(
    pullRequests.length === 0 ? { kind: 'none' } : { kind: 'stack', number, pullRequests },
  );
};

// `gh pr list --head` matches the branch name in any fork, so keep the pull requests from the
// repository the branch pushes to.
export const selectHeadPull = (
  listed: readonly HeadPull[],
  pushRepository: Repository,
): HeadPullChoice => {
  const owned = listed.filter((pull) => fromHeadRepository(pull, pushRepository));
  const [first, ...others] = owned;

  if (first === undefined) {
    return { kind: 'none' };
  }

  if (others.length > 0) {
    return { kind: 'several', numbers: owned.map((pull) => pull.number) };
  }

  return { kind: 'one', pull: first };
};

// A base branch lives in the base repository, so a pull request from a fork is not its pull request.
const pullsFromRepository = (pulls: readonly HeadPull[], repository: Repository) =>
  pulls.filter((pull) => fromHeadRepository(pull, repository));

export const needsBasePull = (pull: HeadPull, defaultBranch: string): boolean =>
  pull.baseRefName !== defaultBranch;

const valueOr = <Value>(read: Read<Value> | null, fallback: Value): Value =>
  read?.ok === true ? read.value : fallback;

export const linkOf = (pull: BasedPull): ChainLink => ({
  branch: pull.headRefName,
  number: pull.number,
  url: pull.url,
});

const chainOf = (
  branch: string,
  headPull: HeadPull | undefined,
  basePulls: readonly HeadPull[],
  basedOn: readonly BasedPull[],
): ChainLink[] => {
  // The base pull requests were listed by the head pull request's base, which is their branch.
  const baseBranch = headPull?.baseRefName ?? '';

  const below = basePulls.map((pull) => ({
    branch: baseBranch,
    number: pull.number,
    url: pull.url,
  }));

  const own =
    headPull === undefined ? [] : [{ branch, number: headPull.number, url: headPull.url }];

  const above = basedOn.map(linkOf);

  return [...below, ...own, ...above];
};

const heldReasons = (
  stacks: StackedPullRequests | undefined,
  basePulls: readonly HeadPull[],
  basedOn: readonly BasedPull[],
) => {
  const held: HeldReason[] = [];

  if (stacks?.kind === 'stack') {
    held.push('githubStack');
  }

  if (basePulls.length > 0) {
    held.push('baseHasOpenPull');
  }

  if (basedOn.length > 0) {
    held.push('openPullBasedOnBranch');
  }

  return held;
};

const severalPullsReason = (branch: string, numbers: readonly number[]) => {
  const listed = numbers.map((number) => `#${number}`).join(', ');

  return `Pull requests ${listed} are all open for ${branch}.`;
};

// The second step of the stack check, from what GitHub says. A failed read is unknown, never
// standalone.
export const decideGithub = (branch: string, facts: GithubFacts): GithubDecision => {
  const failed = failures([facts.headPulls, facts.basedOn, facts.stacks, facts.basePulls]);

  if (failed.length > 0) {
    return { result: 'unknown', reason: describeFailures(failed) };
  }

  const choice = selectHeadPull(valueOr(facts.headPulls, []), facts.pushRepository);

  if (choice.kind === 'several') {
    return { result: 'unknown', reason: severalPullsReason(branch, choice.numbers) };
  }

  const headPull = choice.kind === 'one' ? choice.pull : undefined;
  const stacks = valueOr<StackedPullRequests | undefined>(facts.stacks, undefined);
  const basedOn = valueOr(facts.basedOn, []);
  const basePulls = pullsFromRepository(valueOr(facts.basePulls, []), facts.baseRepository);
  const held = heldReasons(stacks, basePulls, basedOn);

  if (held.length === 0) {
    return { result: 'standalone' };
  }

  const [lowest] = [...basePulls, ...(headPull === undefined ? [] : [headPull])];

  return {
    result: 'untracked',
    held,
    chain: chainOf(branch, headPull, basePulls, basedOn),
    basedOn: basedOn.map(linkOf),
    chainBase: lowest?.baseRefName ?? null,
    githubStack:
      stacks?.kind === 'stack'
        ? { number: stacks.number, pullRequests: stacks.pullRequests }
        : null,
  };
};
