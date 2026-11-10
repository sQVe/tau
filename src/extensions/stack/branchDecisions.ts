import type { CheckResult } from './check.js';
import type { StackViewRead } from './checkDecisions.js';
import { describeFailures, failedExit } from './readResult.js';
import type { CommandOutput, Read } from './readResult.js';

export interface BranchRequest {
  parent: string;
  branch: string;
  trunk: string;
  remote: string;
}

export interface BranchStop {
  result: 'stop';
  reason: string;
}

const stop = (reason: string): BranchStop => ({ result: 'stop', reason });

export const decideBranchParent = (
  check: CheckResult,
  branch: string,
): BranchStop | { result: 'proceed' } => {
  if (check.result === 'unknown') {
    return stop(check.reason);
  }

  const basedOn = 'basedOn' in check ? check.basedOn : [];
  const otherPull = basedOn.find((pull) => pull.branch !== branch);

  if (otherPull !== undefined) {
    return stop(`An open PR from ${otherPull.branch} is based on the parent. A stack cannot fork.`);
  }

  return { result: 'proceed' };
};

export const decideBranchWrite = (
  command: string,
  output: CommandOutput,
): BranchStop | { result: 'done' } =>
  output.exitCode === 0
    ? { result: 'done' }
    : stop(describeFailures([failedExit(command, output)]));

export const decideBranchCheckout = (
  command: string,
  output: CommandOutput,
): BranchStop | { result: 'stacked' | 'unstacked' } => {
  if (output.exitCode === 0) {
    return { result: 'stacked' };
  }

  if (output.exitCode === 2) {
    return { result: 'unstacked' };
  }

  return stop(describeFailures([failedExit(command, output)]));
};

export const decideBranchView = (
  read: StackViewRead,
  request: BranchRequest,
  phase: 'retry' | 'parent' | 'final',
): BranchStop | { result: 'add' | 'inPlace' | 'checkoutParent' } => {
  if (read.exitCode !== 0) {
    return stop(`gh stack view --json exited with code ${read.exitCode}.`);
  }

  if (read.view === null) {
    return stop('gh stack view --json printed no view.');
  }

  if (!read.view.ok) {
    return stop(describeFailures([read.view]));
  }

  const { branches } = read.view.value;
  const parentIndex = branches.findIndex((layer) => layer.name === request.parent);
  const branchIndex = branches.findIndex((layer) => layer.name === request.branch);

  if (phase === 'parent') {
    if (parentIndex === -1) {
      return stop(`gh stack view --json does not list parent ${request.parent}.`);
    }

    return parentIndex === branches.length - 1
      ? { result: 'add' }
      : stop(`A branch sits above ${request.parent} in its stack.`);
  }

  const adjacent = parentIndex !== -1 && branchIndex === parentIndex + 1;

  if (!adjacent && phase === 'retry') {
    return { result: 'checkoutParent' };
  }

  if (!adjacent || branchIndex !== branches.length - 1) {
    return stop(
      `gh stack view --json must show ${request.branch} on top with ${request.parent} directly below.`,
    );
  }

  return { result: 'inPlace' };
};

export const decideParentHistory = (
  commits: Read<string>,
  direction: 'behind' | 'ahead',
): BranchStop | { result: 'fastForward' | 'ready' } => {
  if (!commits.ok) {
    return stop(describeFailures([commits]));
  }

  if (commits.value.trim() === '') {
    return { result: 'ready' };
  }

  return direction === 'behind'
    ? { result: 'fastForward' }
    : stop('The parent has commits ahead of its remote branch.');
};
