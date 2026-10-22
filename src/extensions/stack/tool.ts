import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec, CommandRuntime } from '../../command.js';
import { readChain } from './chain.js';
import { readCheck } from './check.js';
import { readHistory } from './history.js';

export const stackToolParameters = Type.Object({
  action: Type.Union([Type.Literal('check'), Type.Literal('history'), Type.Literal('chain')]),
  remote: Type.Optional(
    Type.String({
      description:
        'check: the Git remote the branch pushes to, when it has no push target. history: the remote to compare with.',
    }),
  ),
  branch: Type.Optional(
    Type.String({
      description: 'check: the branch to check. Defaults to the current branch.',
    }),
  ),
  startTips: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'history: for each branch rebased since its last push, its tip before the first of those rebases, as a commit SHA.',
    }),
  ),
  pullRequests: Type.Optional(
    Type.Array(Type.String(), {
      description: 'chain: the URLs of the open blocker pull requests, all in one repository.',
    }),
  ),
  slicePullRequest: Type.Optional(
    Type.String({ description: "chain: the URL of the slice's own pull request, if it has one." }),
  ),
});

export type StackInput = Static<typeof stackToolParameters>;

const description = `Read-only stack decisions. Every result has an evidence object with the facts and failed reads it decided from. A read that fails gives unknown or stop, never a guess.
- action check {remote?, branch?}: the stack check of a branch, the current one by default. Another branch gets only GitHub reads, never local ones. result is one of:
  - tracked: a local stack holds the branch. Returns trunk, parent (the nearest branch below with isMerged false, else the trunk), layers (bottom to top), and basedOn (the open pull requests based on the branch).
  - untracked: a GitHub stack holds the branch's pull request, the pull request's base branch has an open pull request, or an open pull request is based on the branch. Returns held (githubStack, baseHasOpenPull, openPullBasedOnBranch), chain (the pull requests found, bottom to top, maybe not the whole chain), basedOn (each {branch, number, url}), chainBase (the lowest pull request's base), and githubStack ({number, pullRequests} bottom to top, or null).
  - standalone: none of those hold.
  - unknown: with a reason, such as a paused stack rebase, several stacks, several open pull requests for the branch, or any failed read.
- action history {remote, startTips?}: the remote-history check of every active branch (not merged, not queued) of the local stack, bottom to top. startTips maps a branch to its tip from before you rebased it since its last push. Each layer has status and remoteTip (the SHA of <remote>/<branch> now, or null). Status is one of:
  - unpublished: no <remote>/<branch>.
  - current: the remote has no commits the tip lacks.
  - behind: the remote has commits, the branch was not rebased since its last push, and it is an ancestor of the remote branch.
  - rewritten: the remote branch holds the same changes as the branch before a restack, such as after a lower pull request merged.
  - diverged: none of the above.
  - unknown: a read failed. reason names it.
  - stop is set, with no layers, when the stack branches could not be read.
- action chain {pullRequests, slicePullRequest?}: the blocker-chain rule of start-slice. pullRequests are the open blocker pull request URLs, all in one repository. slicePullRequest is the slice's own pull request, which is not counted as above the parent. result is stop, with reason, or parent.
  - stop: a read failed, a blocker is not open, several blockers are open and no GitHub stack holds them or they sit in different stacks, or open pull requests are based on the parent and no GitHub stack holds it.
  - parent: the blocker highest in the GitHub stack that holds all blockers, or the only blocker. Returns parent {number, url, branch}; branchAbove (an open pull request other than slicePullRequest is based on the parent, or the parent's stack lists one above it); above (those pull request numbers); githubStack ({number, pullRequests, topBranch, topPullRequest}, or null); and trunk (the base of the bottom pull request of the parent's stack, else the default branch).`;

const runAction = async (
  exec: Exec,
  cwd: string,
  parameters: StackInput,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> => {
  const runtime: CommandRuntime = { exec, cwd, signal };

  if (parameters.action === 'check') {
    return {
      ...(await readCheck(runtime, { remote: parameters.remote, branch: parameters.branch })),
    };
  }

  if (parameters.action === 'history') {
    if (parameters.remote === undefined) {
      throw new Error('history needs remote.');
    }

    const request = { remote: parameters.remote, startTips: parameters.startTips };

    return { ...(await readHistory(runtime, request)) };
  }

  if (parameters.pullRequests === undefined) {
    throw new Error('chain needs pullRequests.');
  }

  const request = {
    pullRequests: parameters.pullRequests,
    slicePullRequest: parameters.slicePullRequest,
  };

  return { ...(await readChain(runtime, request)) };
};

export const createStackTool = (
  exec: Exec,
): ToolDefinition<typeof stackToolParameters, Record<string, unknown>> =>
  defineTool({
    name: 'stack',
    label: 'Stack',
    description,
    promptSnippet:
      'Check whether a branch is in a stack, check the remote history of the stack branches before a push, and decide the parent of a stacked slice. Reads only.',
    parameters: stackToolParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const details = await runAction(exec, context.cwd, parameters, signal);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
