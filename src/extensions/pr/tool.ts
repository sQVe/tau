import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec } from '../../exec.js';
import type { Runtime } from '../../github.js';
import { readGitOutput } from '../../gitOutput.js';
import { createFreshTauDirectory } from '../../tauDirectory.js';
import { readTarget } from './target.js';

export const prToolParameters = Type.Object({
  action: Type.Union([Type.Literal('prepare'), Type.Literal('target')]),
  remote: Type.Optional(
    Type.String({ description: 'target: the Git remote to push the branch to.' }),
  ),
  base: Type.Optional(
    Type.String({
      description: 'target: the base branch to use when no open pull request names one.',
    }),
  ),
});

export type PrInput = Static<typeof prToolParameters>;

const description = `Prepare a pull request run and resolve its target.

- action prepare: creates a fresh, Git-ignored run directory for the files of one run. Returns {directory}, an absolute path to .tau/pr/run-XXXXXX.
- action target {remote?, base?}: resolves where the current branch's pull request goes. It does not rebase, push, or write to GitHub.
  - Runs gh auth status --active --hostname <host> before other gh calls.
  - Head: the named remote, else the push target from @{push}, else the sole remote with a branch of the local branch name. The head repository comes from that remote's push URL.
  - Base repository: the upstream when the head repository is a fork, otherwise the head repository.
  - Pull requests: lists the head branch's pull requests in the base repository and keeps the head owner's.
  - Base branch: the open pull request's base, else base, else the base repository's default branch. Fetches it from the base remote into <remote>/<base> and pins the merge base with HEAD.
  - Returns {host, repository, head: {remote, repository, owner, branch, sha}, base: {remote, branch}, mergeBase, pr, closedPrs}. repository is the base repository as <host>/<owner>/<name>. head.sha is the local HEAD. pr is the open pull request or null. closedPrs lists merged and closed ones. Each pull request has number, url, state, title, body, baseRefName, isDraft, and headRefOid.
  - Errors: a detached HEAD; the default branch checked out; a remote that is not a Git remote; no head remote found, or several; a head remote push URL that names no GitHub repository; a failing gh auth status; no Git remote for a fork's upstream; gh output the tool cannot read, named with the command; more than one open pull request for the branch; a failed fetch of the base branch.`;

const findRoot = async (cwd: string) => {
  const output = await readGitOutput(cwd, ['rev-parse', '--show-toplevel']);
  const root = output?.trim();

  if (root === undefined || root === '') {
    throw new Error(`The pr tool needs a Git checkout, and ${cwd} is not in one.`);
  }

  return root;
};

const prepare = async (runtime: Runtime) => {
  const root = await findRoot(runtime.cwd);

  return { directory: await createFreshTauDirectory(root, 'pr', 'run-') };
};

const runAction = async (
  exec: Exec,
  cwd: string,
  parameters: PrInput,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> => {
  const runtime = { exec, cwd, signal };

  if (parameters.action === 'prepare') {
    return prepare(runtime);
  }

  return { ...(await readTarget(runtime, { remote: parameters.remote, base: parameters.base })) };
};

export const createPrTool = (
  exec: Exec,
): ToolDefinition<typeof prToolParameters, Record<string, unknown>> =>
  defineTool({
    name: 'pr',
    label: 'PR',
    description,
    promptSnippet: "Prepare a pull request run and resolve the branch's pull request target.",
    parameters: prToolParameters,
    defaultActive: false,
    executionMode: 'sequential',
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const details = await runAction(exec, context.cwd, parameters, signal);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
