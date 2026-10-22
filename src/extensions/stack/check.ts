import { access } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandRuntime } from '../../command.js';
import type { Repository } from '../../github/github.js';
import { resolveBaseRepository, resolveHead } from '../../github/repositoryTarget.js';
import { readOptionalGit } from '../../gitOutput.js';
import {
  decideGithub,
  decideStackView,
  needsBasePull,
  selectHeadPull,
  linkOf,
} from './checkDecisions.js';
import type {
  BasedPull,
  ChainLink,
  CurrentBranchFacts,
  GithubDecision,
  GithubFacts,
  ViewOutcome,
} from './checkDecisions.js';
import { readFailed, readOk } from './readResult.js';
import type { Read } from './readResult.js';
import {
  readBasedOnPulls,
  readHeadPulls,
  readStacks,
  readStackViewFacts,
  runGitRead,
} from './reads.js';

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

export type CheckResult = (ViewOutcome | GithubDecision | { basedOn: ChainLink[] }) & {
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
  const output = await runGitRead(runtime.cwd, ['rev-parse', '--absolute-git-dir']);
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
): Promise<GithubFacts> => {
  const { pushRepository, baseRepository, defaultBranch, serverBranch } = resolved;

  const [headPulls, basedOn] = await Promise.all([
    readHeadPulls(runtime, baseRepository, serverBranch),
    readBasedOnPulls(runtime, baseRepository, serverBranch),
  ]);

  const choice = headPulls.ok ? selectHeadPull(headPulls.value, pushRepository) : undefined;
  const pull = choice?.kind === 'one' ? choice.pull : undefined;
  const stacks = pull === undefined ? null : await readStacks(runtime, baseRepository, pull.number);
  const needsBase = pull !== undefined && needsBasePull(pull, defaultBranch);

  const basePulls = needsBase
    ? await readHeadPulls(runtime, baseRepository, pull.baseRefName)
    : null;

  return { defaultBranch, pushRepository, baseRepository, headPulls, basedOn, stacks, basePulls };
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

  const github = await gatherGithubFacts(runtime, resolved.value);
  const decision = decideGithub(branch, github);

  return { ...decision, branch, evidence: { current, resolved, github } };
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
  const evidence = { current, resolved: null, github: null };

  if (!current.rebasePaused && branch === undefined) {
    return unknownResult(
      'HEAD is detached, so the current branch is unknown. Pass branch.',
      null,
      evidence,
    );
  }

  const decision = decideStackView(branch ?? '', current);

  if (decision.result === 'github' && branch !== undefined) {
    return checkOnGithub(runtime, request, branch, current);
  }

  if (decision.result === 'github') {
    return unknownResult('The current branch is unknown.', null, evidence);
  }

  if (decision.result === 'tracked' && branch !== undefined) {
    return checkTracked(runtime, request, branch, current, decision);
  }

  return { ...decision, branch: branch ?? null, evidence };
};

// Runs the stack check on the current branch, or on another branch with only the GitHub reads.
export const readCheck = async (
  runtime: CommandRuntime,
  request: CheckRequest,
): Promise<CheckResult> => {
  const currentBranch = await readOptionalGit(runtime.cwd, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);

  const { branch } = request;

  if (branch !== undefined && branch !== currentBranch) {
    return checkOnGithub(runtime, request, branch, null);
  }

  return checkCurrent(runtime, request, branch ?? currentBranch);
};
