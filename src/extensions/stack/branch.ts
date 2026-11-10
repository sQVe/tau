import type { CommandRuntime } from '../../command.js';
import { runGit } from '../../git.js';
import { label, runOutcome } from '../../github/github.js';
import {
  decideBranchCheckout,
  decideBranchParent,
  decideBranchView,
  decideBranchWrite,
  decideParentHistory,
} from './branchDecisions.js';
import type { BranchRequest, BranchStop } from './branchDecisions.js';
import { readCheck } from './check.js';
import { requireStackView } from './checkDecisions.js';
import {
  describeFailures,
  failedExit,
  ghCommandOutput,
  gitCommandOutput,
  readOk,
} from './readResult.js';
import type { CommandOutput } from './readResult.js';
import { gitLabel, readStackViewFacts } from './reads.js';

export type BranchResult = (BranchStop | { result: 'created' | 'inPlace' }) & { writes: string[] };

interface BranchRun {
  runtime: CommandRuntime;
  request: BranchRequest;
  writes: string[];
}

const requireSuccess = (command: string, output: CommandOutput): void => {
  const decision = decideBranchWrite(command, output);

  if (decision.result === 'stop') {
    throw new Error(decision.reason);
  }
};

const gitRead = async (
  runtime: CommandRuntime,
  commandArguments: string[],
): Promise<CommandOutput> => {
  const options = runtime.signal === undefined ? {} : { signal: runtime.signal };

  return gitCommandOutput(await runGit(runtime.cwd, commandArguments, options));
};

const gitWrite = async (run: BranchRun, commandArguments: string[]): Promise<void> => {
  const command = gitLabel(commandArguments);

  run.writes.push(command);

  const output = await gitRead(run.runtime, commandArguments);

  requireSuccess(command, output);
};

const ghWrite = async (run: BranchRun, commandArguments: string[]): Promise<CommandOutput> => {
  run.writes.push(label(commandArguments));

  return ghCommandOutput(await runOutcome(run.runtime, commandArguments));
};

const localBranchExists = async (runtime: CommandRuntime, branch: string): Promise<boolean> => {
  const commandArguments = ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`];
  const output = await gitRead(runtime, commandArguments);

  if (output.exitCode === 1) {
    return false;
  }

  requireSuccess(gitLabel(commandArguments), output);

  return true;
};

const checkout = async (run: BranchRun, branch: string) => {
  const commandArguments = ['stack', 'checkout', branch];
  const output = await ghWrite(run, commandArguments);

  return decideBranchCheckout(label(commandArguments), output);
};

const viewDecision = async (run: BranchRun, phase: 'retry' | 'parent' | 'final') => {
  const view = requireStackView(await readStackViewFacts(run.runtime));

  if (!view.ok) {
    return { result: 'stop' as const, reason: describeFailures([view]) };
  }

  return decideBranchView(view.value, run.request, phase);
};

const checkoutExisting = async (run: BranchRun) => {
  if (!(await localBranchExists(run.runtime, run.request.branch))) {
    return { result: 'checkoutParent' as const };
  }

  const checked = await checkout(run, run.request.branch);

  if (checked.result === 'stop') {
    return checked;
  }

  return checked.result === 'stacked'
    ? viewDecision(run, 'retry')
    : { result: 'checkoutParent' as const };
};

const parentHistory = async (run: BranchRun, direction: 'behind' | 'ahead') => {
  const { parent, remote } = run.request;
  const localReference = `refs/heads/${parent}`;
  const remoteReference = `refs/remotes/${remote}/${parent}`;

  const range =
    direction === 'behind'
      ? `${localReference}..${remoteReference}`
      : `${remoteReference}..${localReference}`;

  const commandArguments = ['log', '--oneline', range, '--'];
  const output = await gitRead(run.runtime, commandArguments);

  const read =
    output.exitCode === 0 ? readOk(output.stdout) : failedExit(gitLabel(commandArguments), output);

  return decideParentHistory(read, direction);
};

const updateParent = async (run: BranchRun, stacked: boolean): Promise<BranchStop | null> => {
  const { parent, remote } = run.request;

  await gitWrite(run, ['fetch', remote, `refs/heads/${parent}:refs/remotes/${remote}/${parent}`]);

  if (!stacked) {
    const exists = await localBranchExists(run.runtime, parent);

    const commandArguments = exists
      ? ['switch', parent]
      : ['switch', '--no-track', '-c', parent, `${remote}/${parent}`];

    await gitWrite(run, commandArguments);
  }

  const behind = await parentHistory(run, 'behind');

  if (behind.result === 'stop') {
    return behind;
  }

  if (behind.result === 'fastForward') {
    await gitWrite(run, ['merge', '--ff-only', `${remote}/${parent}`]);
  }

  const ahead = await parentHistory(run, 'ahead');

  return ahead.result === 'stop' ? ahead : null;
};

const createOnParent = async (run: BranchRun): Promise<BranchStop | null> => {
  const checked = await checkout(run, run.request.parent);

  if (checked.result === 'stop') {
    return checked;
  }

  const stacked = checked.result === 'stacked';
  const stopped = await updateParent(run, stacked);

  if (stopped !== null) {
    return stopped;
  }

  if (stacked) {
    const decision = await viewDecision(run, 'parent');

    if (decision.result === 'stop') {
      return decision;
    }
  }

  const { branch, parent, trunk } = run.request;

  const commandArguments = stacked
    ? ['stack', 'add', branch]
    : ['stack', 'init', '--base', trunk, parent, branch];

  const output = await ghWrite(run, commandArguments);

  requireSuccess(label(commandArguments), output);

  return null;
};

const runBranch = async (run: BranchRun): Promise<BranchResult> => {
  const { runtime, request, writes } = run;
  const check = await readCheck(runtime, { branch: request.parent, remote: request.remote });
  const parent = decideBranchParent(check, request.branch);

  if (parent.result === 'stop') {
    return { ...parent, writes };
  }

  const existing = await checkoutExisting(run);

  if (existing.result === 'stop') {
    return { ...existing, writes };
  }

  const inPlace = existing.result === 'inPlace';

  if (!inPlace) {
    const stopped = await createOnParent(run);

    if (stopped !== null) {
      return { ...stopped, writes };
    }
  }

  const final = await viewDecision(run, 'final');

  return final.result === 'stop'
    ? { ...final, writes }
    : { result: inPlace ? 'inPlace' : 'created', writes };
};

export const createBranch = async (
  runtime: CommandRuntime,
  request: BranchRequest,
): Promise<BranchResult> => {
  const writes: string[] = [];

  try {
    return await runBranch({ runtime, request, writes });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return { result: 'stop', reason, writes };
  }
};
