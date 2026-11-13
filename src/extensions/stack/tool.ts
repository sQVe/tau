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

const description = `Read-only stack decisions; evidence: facts/failed reads. Failed reads yield unknown/stop.
- check {remote?,branch?}: current branch by default; other branches: GitHub only. result:
  tracked: local stack; {trunk,parent,layers,basedOn}. parent: nearest unmerged branch below, else trunk; layers: bottom-to-top; basedOn: open PRs based on branch.
  untracked: held lists githubStack|baseHasOpenPull|openPullBasedOnBranch; chain: bottom-to-top PRs, possibly incomplete; basedOn: [{branch,number,url}]; chainBase: lowest PR's base or null; githubStack: {number,pullRequests} bottom-to-top, or null.
  standalone: none hold; unknown: reason names missing/ambiguous evidence.
- history {remote,startTips?}: active local branches (not merged/queued), bottom-to-top. Layers: remoteTip (remote SHA or null), status: unpublished (no remote branch), current (no remote-only commits), behind (not rebased since push, ancestor of remote), rewritten (remote has pre-restack changes), diverged (otherwise), unknown (failed read, with reason). stop with no layers: unread stack branches.
- chain {pullRequests,slicePullRequest?}: start-slice parent from open blocker PR URLs in one repository; excludes slicePullRequest from above-parent checks. decision.result: stop with reason, or parent (highest blocker in their shared GitHub stack, else sole blocker). parent: {number,url,branch}; branchAbove: another open PR based on parent or above it in stack; above: those PR numbers; githubStack: {number,pullRequests,topBranch,topPullRequest} or null; trunk: bottom stack PR's base, else default branch.
- link {pr,remote}: plan/check local stack's top PR link. result: command (exact command, needs approval), linked (top PR and all bases match), none (one open PR), stop (unsafe/missing evidence, with reason).`;

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
