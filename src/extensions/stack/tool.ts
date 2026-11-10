import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec, CommandRuntime } from '../../command.js';
import { readChain } from './chain.js';
import { readCheck } from './check.js';
import { readHistory } from './history.js';
import { readLink } from './link.js';

export const stackToolParameters = Type.Object({
  action: Type.Union([
    Type.Literal('check'),
    Type.Literal('history'),
    Type.Literal('chain'),
    Type.Literal('link'),
  ]),
  pr: Type.Optional(
    Type.Integer({ minimum: 1, description: 'link: the PR number in the base repository.' }),
  ),
  remote: Type.Optional(
    Type.String({
      description:
        'check: the Git remote when ambiguous. history: the comparison remote. link: the remote for the returned command.',
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

const description = `Read-only stack decisions. evidence holds the facts or failed reads. Failed reads give unknown or stop, never a guess.
- check {remote?, branch?}: check the current branch by default. Another branch gets only GitHub reads. result:
  - tracked: a local stack holds the branch. Returns trunk, parent (nearest unmerged branch below, else trunk), layers (bottom to top), and basedOn (open PRs based on the branch).
  - untracked: held lists githubStack, baseHasOpenPull, or openPullBasedOnBranch. Returns chain (PRs found, bottom to top, possibly incomplete), basedOn (each {branch, number, url}), chainBase (lowest PR's base), and githubStack ({number, pullRequests} bottom to top, or null).
  - standalone: none of those hold.
  - unknown: reason explains missing or ambiguous evidence.
- history {remote, startTips?}: check every active local stack branch (not merged or queued), bottom to top. startTips maps branches to tips before their first rebase since their last push. Each layer has remoteTip (current remote SHA or null) and status:
  - unpublished: no remote branch.
  - current: remote has no commits the local tip lacks.
  - behind: not rebased since the last push, and an ancestor of the remote branch.
  - rewritten: remote holds the same changes as before a restack.
  - diverged: none of the above.
  - unknown: reason names a failed read.
  - stop is set with no layers when stack branches could not be read.
- chain {pullRequests, slicePullRequest?}: decide the parent for start-slice. pullRequests are open blocker PR URLs in one repository. slicePullRequest is the slice's own PR URL, excluded from above-parent checks. decision.result is stop (with reason) or parent: the highest blocker in the GitHub stack holding all blockers, or the only blocker. Returns parent {number, url, branch}, branchAbove (another open PR is based on the parent or listed above it in its stack), above (those PR numbers), githubStack ({number, pullRequests, topBranch, topPullRequest}, or null), and trunk (bottom stack PR's base, else default branch).
- link {pr, remote}: plan linking the local stack's top PR, or check a completed link. pr is its number in the base repository. result:
  - command: command is the exact gh stack link command to run after approval. It appends to the GitHub stack below, or creates one with open local PRs bottom to top and the local trunk as base.
  - linked: GitHub lists this PR at the top and every open PR has the expected base.
  - none: one open PR needs no link.
  - stop: reason explains why linking is unsafe or evidence is missing. No command runs.`;

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

  if (parameters.action === 'link') {
    if (parameters.pr === undefined) {
      throw new Error('link needs pr.');
    }

    if (parameters.remote === undefined) {
      throw new Error('link needs remote.');
    }

    return { ...(await readLink(runtime, { pr: parameters.pr, remote: parameters.remote })) };
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
      "Check stack membership and remote history, decide a stacked slice's parent, or plan a PR's stack link. Reads only.",
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
