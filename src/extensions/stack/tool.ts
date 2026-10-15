import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec } from '../../exec.js';
import type { Runtime } from '../../github.js';
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

const description = `Read-only stack decisions. Never runs gh stack add, init, rebase, push, sync, link, or checkout, or any other write. Every result has an evidence object with the facts it decided from, including the reads that failed. A command whose output cannot be read is a failed read, which gives unknown or stop, never a guess.
- action check {remote?, branch?}: the stack check of a branch. result is one of:
  - tracked: gh stack view --json exited 0. Also reads the open pull requests based on the branch, and returns them as basedOn. Returns trunk, parent (the nearest branch below with isMerged false, else the trunk), and layers (bottom to top).
  - untracked: a GitHub stack holds the branch's pull request, the pull request's base branch has an open pull request, or an open pull request is based on the branch. Returns held (githubStack, baseHasOpenPull, openPullBasedOnBranch), chain (the pull requests the reads found, bottom to top, which may not be the whole chain), basedOn (the open pull requests based on the branch, each with {branch, number, url}), chainBase (the base of the lowest pull request in the chain), and githubStack ({number, pullRequests} with the GitHub stack number and its pull requests bottom to top, or null).
  - standalone: none of those hold.
  - unknown: with a reason. Causes: a paused stack rebase (gh-stack-rebase-state exists), gh stack view exit 6 (several stacks), an exit code other than 0 and 2, several open pull requests for the branch from the push repository, or any failed read.
  - Without branch, or when branch is the current branch, it runs gh stack view --json first. Exit 2 means no local stack and leads to the GitHub reads. With another branch it runs only the GitHub reads.
  - GitHub reads: the open pull requests with that head (kept when their head repository is the one the branch pushes to), the open pull requests based on the branch, the stacks API for the pull request (404 means stacked pull requests are off, [] means no stack holds it), and, when the pull request's base is not the default branch, the open pull requests with that base as head (kept when from the base repository).
  - Errors: not in a Git checkout.
- action history {remote, startTips?}: the remote-history check of every active branch (not merged, not queued) in gh stack view --json, bottom to top. Each layer has status and remoteTip (the SHA of <remote>/<branch> now, or null). Status is one of:
  - unpublished: no <remote>/<branch>.
  - current: git log <tip>..<remote>/<branch> lists nothing. The tip is startTips[branch] or the local branch.
  - behind: the remote has commits, the branch was not rebased since its last push (no startTips entry), and it is an ancestor of the remote branch.
  - rewritten: git cherry <tip> <remote>/<branch> <remote>/<new parent> and git cherry <remote>/<branch> <tip> <old parent> both print at least one line and only lines that start with -. The new parent is the first unmerged branch below, or the trunk. The old parent is the local branch directly below, merged or not, or the trunk for the bottom branch. Empty git cherry output does not prove a rewrite, so the layer is diverged.
  - diverged: none of the above.
  - unknown: a read the status needs failed. reason names it.
  - stop is set, with no layers, when gh stack view --json did not give the branches.
  - Errors: remote is not a Git remote; a startTips value that is not a commit SHA.
- action chain {pullRequests, slicePullRequest?}: the blocker-chain rule of start-slice. pullRequests are the open blocker pull request URLs, all in one repository. result is stop, with reason, or parent.
  - stop: a read failed, a blocker is not open, several blockers are open and no GitHub stack holds them or they sit in different stacks, or open pull requests are based on the parent and no GitHub stack holds it.
  - parent: the blocker highest in the GitHub stack that holds all blockers, or the only blocker. Returns parent {number, url, branch}; branchAbove (an open pull request other than slicePullRequest is based on the parent, or the parent's stack lists a pull request above it); above (those pull request numbers); githubStack ({number, pullRequests, topBranch, topPullRequest}, or null when no stack holds the parent); and trunk (the base of the bottom pull request of the parent's stack, else the default branch).
  - Errors: no pullRequests; a URL that is not https://<host>/<owner>/<name>/pull/<number>; pull requests of different repositories.`;

const runAction = async (
  exec: Exec,
  cwd: string,
  parameters: StackInput,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> => {
  const runtime: Runtime = { exec, cwd, signal };

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
