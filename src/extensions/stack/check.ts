import { access } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandRuntime } from '../../command.js';
import { runGit } from '../../git.js';
import type { Repository } from '../../github/github.js';
import { resolveBaseRepository, resolveHead } from '../../github/repositoryTarget.js';
import {
  decideGithub,
  decideStackView,
  needsBasePull,
  normalizeGithubFacts,
  selectHeadPull,
  linkOf,
} from './checkDecisions.js';
import type {
  BasedPull,
  ChainLink,
  CurrentBranchFacts,
  GithubDecision,
  GithubFacts,
  HeadPullChoice,
  ViewOutcome,
} from './checkDecisions.js';
import { gitCommandOutput, readFailed, readOk } from './readResult.js';
import type { Read } from './readResult.js';
import { readBasedOnPulls, readHeadPulls, readStacks, readStackViewFacts } from './reads.js';

interface GatheredGithub {
  reads: GithubFacts;
  headPull: Read<HeadPullChoice>;
}

export interface CheckRequest {
  remote: string | undefined;
  branch: string | undefined;
}

interface Resolved {
  pushRepository: Repository;
  baseRepository: Repository;
  defaultBranch: string;
  // The branch name on the remote, which can differ from the local name.
  serverBranch: string;
}

interface CheckEvidence {
  current: CurrentBranchFacts | null;
  resolved: Read<Resolved> | null;
  github: GithubFacts | null;
  basedOn?: Read<BasedPull[]>;
}

type TrackedCheck = Extract<ViewOutcome, { result: 'tracked' }> & { basedOn: ChainLink[] };
type OtherCheck = Exclude<ViewOutcome | GithubDecision, { result: 'tracked' }>;

export type CheckResult = (TrackedCheck | OtherCheck) & {
  branch: string | null;
  evidence: CheckEvidence;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
};

const readCurrentFacts = async (runtime: CommandRuntime): Promise<Read<CurrentBranchFacts>> => {
  const command = 'git rev-parse --absolute-git-dir';
  const output = gitCommandOutput(await runGit(runtime.cwd, ['rev-parse', '--absolute-git-dir']));
  const directory = output.stdout.trim();

  if (output.exitCode !== 0 || directory === '') {
    return readFailed(command, `failed: ${output.stderr.trim()}`);
  }

  const rebasePaused = await exists(join(directory, 'gh-stack-rebase-state'));

  // A paused rebase leaves HEAD detached, and gh stack view then cannot name the branch.
  if (rebasePaused) {
    return readOk({ rebasePaused, stackView: null });
  }

  return readOk({ rebasePaused, stackView: await readStackViewFacts(runtime) });
};

const resolve = async (
  runtime: CommandRuntime,
  request: CheckRequest,
  branch: string,
): Promise<Read<Resolved>> => {
  try {
    const head = await resolveHead(runtime, { remote: request.remote, branch });
    const base = await resolveBaseRepository(runtime, head.repository);

    return readOk({
      pushRepository: head.repository,
      baseRepository: base.repository,
      defaultBranch: base.defaultBranch,
      serverBranch: head.branch,
    });
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);

    return readFailed('resolve the push repository and the base repository', problem);
  }
};

const gatherGithubFacts = async (
  runtime: CommandRuntime,
  resolved: Resolved,
): Promise<GatheredGithub> => {
  const { pushRepository, baseRepository, defaultBranch, serverBranch } = resolved;

  const [headPulls, basedOn] = await Promise.all([
    readHeadPulls(runtime, baseRepository, serverBranch),
    readBasedOnPulls(runtime, baseRepository, serverBranch),
  ]);

  const headPull: Read<HeadPullChoice> = headPulls.ok
    ? readOk(selectHeadPull(headPulls.value, pushRepository))
    : headPulls;

  const pull = headPull.ok && headPull.value.kind === 'one' ? headPull.value.pull : undefined;
  const basePullNeeded = pull !== undefined && needsBasePull(pull, defaultBranch);

  const [stacks, basePulls] = await Promise.all([
    pull === undefined ? null : readStacks(runtime, baseRepository, pull.number),
    basePullNeeded ? readHeadPulls(runtime, baseRepository, pull.baseRefName) : null,
  ]);

  const reads: GithubFacts = {
    defaultBranch,
    pushRepository,
    baseRepository,
    headPulls,
    basedOn,
    stacks,
    basePulls,
  };

  return { reads, headPull };
};

const unknownResult = (
  reason: string,
  branch: string | null,
  evidence: CheckEvidence,
): CheckResult => ({ result: 'unknown', reason, branch, evidence });

const checkOnGithub = async (
  runtime: CommandRuntime,
  request: CheckRequest,
  branch: string,
  current: CurrentBranchFacts | null,
): Promise<CheckResult> => {
  const resolved = await resolve(runtime, request, branch);

  if (!resolved.ok) {
    const evidence = { current, resolved, github: null };

    return unknownResult(`${resolved.command} ${resolved.problem}`, branch, evidence);
  }

  const { reads, headPull } = await gatherGithubFacts(runtime, resolved.value);
  const evidence = { current, resolved, github: reads };
  const outcome = normalizeGithubFacts(reads, headPull);

  if (outcome.result === 'unknown') {
    return unknownResult(outcome.reason, branch, evidence);
  }

  return { ...decideGithub(branch, outcome.facts), branch, evidence };
};

// A local stack can miss a pull request based on the branch, so a tracked branch also reads those.
const checkTracked = async (
  runtime: CommandRuntime,
  request: CheckRequest,
  branch: string,
  current: CurrentBranchFacts,
  decision: Extract<ViewOutcome, { result: 'tracked' }>,
): Promise<CheckResult> => {
  const resolved = await resolve(runtime, request, branch);

  if (!resolved.ok) {
    const evidence = { current, resolved, github: null };

    return unknownResult(`${resolved.command} ${resolved.problem}`, branch, evidence);
  }

  const { baseRepository, serverBranch } = resolved.value;
  const read = await readBasedOnPulls(runtime, baseRepository, serverBranch);
  const evidence = { current, resolved, github: null, basedOn: read };

  if (!read.ok) {
    return unknownResult(`${read.command} ${read.problem}`, branch, evidence);
  }

  return { ...decision, basedOn: read.value.map(linkOf), branch, evidence };
};

const checkDecidedCurrent = async (
  runtime: CommandRuntime,
  request: CheckRequest,
  branch: string | undefined,
  current: CurrentBranchFacts,
): Promise<CheckResult> => {
  const evidence = { current, resolved: null, github: null };
  const decision = decideStackView(branch ?? '', current);

  if (decision.result === 'github' && branch !== undefined) {
    return checkOnGithub(runtime, request, branch, current);
  }

  if (decision.result === 'tracked' && branch !== undefined) {
    return checkTracked(runtime, request, branch, current, decision);
  }

  if (decision.result === 'github' || decision.result === 'tracked') {
    return unknownResult('The current branch is unknown.', null, evidence);
  }

  return { ...decision, branch: branch ?? null, evidence };
};

const checkCurrent = async (
  runtime: CommandRuntime,
  request: CheckRequest,
  branch: string | undefined,
): Promise<CheckResult> => {
  const read = await readCurrentFacts(runtime);

  if (!read.ok) {
    const evidence = { current: null, resolved: null, github: null };

    return unknownResult(`${read.command} ${read.problem}`, branch ?? null, evidence);
  }

  const current = read.value;

  if (!current.rebasePaused && branch === undefined) {
    const evidence = { current, resolved: null, github: null };

    return unknownResult(
      'HEAD is detached, so the current branch is unknown. Pass branch.',
      null,
      evidence,
    );
  }

  return checkDecidedCurrent(runtime, request, branch, current);
};

// Runs the stack check on the current branch, or on another branch with only the GitHub reads.
export const readCheck = async (
  runtime: CommandRuntime,
  request: CheckRequest,
): Promise<CheckResult> => {
  const branchRead = await runGit(runtime.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);

  if (branchRead.exitCode !== 0 && branchRead.exitCode !== 1) {
    throw new Error(`git symbolic-ref --quiet --short HEAD failed: ${branchRead.stderr.trim()}`);
  }

  const currentBranch =
    branchRead.exitCode === 0 ? branchRead.stdout.toString('utf8').trim() : undefined;

  const { branch } = request;

  if (branch !== undefined && branch !== currentBranch) {
    return checkOnGithub(runtime, request, branch, null);
  }

  return checkCurrent(runtime, request, branch ?? currentBranch);
};
