import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec } from '../../exec.js';
import type { Runtime } from '../../github.js';
import { readGitOutput } from '../../gitOutput.js';
import { createFreshTauDirectory } from '../../tauDirectory.js';
import { readReuse } from './reuse.js';
import { readTarget } from './target.js';

export const prToolParameters = Type.Object({
  action: Type.Union([Type.Literal('prepare'), Type.Literal('target'), Type.Literal('reuse')]),
  remote: Type.Optional(
    Type.String({ description: 'target: the Git remote to push the branch to.' }),
  ),
  base: Type.Optional(
    Type.String({
      description: 'target: the base branch to use when no open pull request names one.',
    }),
  ),
  directory: Type.Optional(
    Type.String({ description: 'reuse: the .tau/workers/review-* directory of a saved review.' }),
  ),
  mergeBase: Type.Optional(
    Type.String({ description: 'reuse: the merge base of the branch, such as target returns.' }),
  ),
});

export type PrInput = Static<typeof prToolParameters>;

const description = `Prepare a pull request run, resolve its target, and check whether a saved review covers the branch.

- action prepare: creates a fresh, Git-ignored run directory for the files of one run. Returns {directory}, an absolute path to .tau/pr/run-XXXXXX.
- action target {remote?, base?}: resolves where the current branch's pull request goes. It does not rebase, push, or write to GitHub.
  - Runs gh auth status --active --hostname <host> before other gh calls.
  - Head: the named remote, else the push target from @{push}, else the sole remote with a branch of the local branch name. The head repository comes from that remote's push URL.
  - Base repository: the upstream when the head repository is a fork, otherwise the head repository.
  - Pull requests: lists the head branch's pull requests in the base repository and keeps the head owner's.
  - Base branch: the open pull request's base, else base, else the base repository's default branch. Fetches it from the base remote into <remote>/<base> and pins the merge base with HEAD.
  - Returns {host, repository, head: {remote, repository, owner, branch, sha}, base: {remote, branch}, mergeBase, pr, closedPrs}. repository is the base repository as <host>/<owner>/<name>. head.sha is the local HEAD. pr is the open pull request or null. closedPrs lists merged and closed ones. Each pull request has number, url, state, title, body, baseRefName, isDraft, and headRefOid.
  - Errors: a detached HEAD; the default branch checked out; a remote that is not a Git remote; no head remote found, or several; a head remote push URL that names no GitHub repository; a failing gh auth status; no Git remote for a fork's upstream; gh output the tool cannot read, named with the command; more than one open pull request for the branch; a failed fetch of the base branch.
- action reuse {directory, mergeBase}: checks whether the saved code review in directory covers git diff <mergeBase> HEAD. It writes nothing.
  - Reads directory/capture.json and directory/recheck.diff, which code_review freshness writes.
  - Splits recheck.diff and git diff --no-ext-diff --no-textconv --no-color <mergeBase> HEAD at each "diff --git" line. Each path's section must be byte-identical, including mode, deletion, rename, and binary lines, and neither side may have an extra path. Path order does not matter.
  - Returns {status, reasons, recordedBase, paths: {differing, missing, extra}, reports}. status is match when there is no reason, else mismatch. Reasons: recheck.diff's git hash-object --no-filters is not the recorded capture hash; the recorded base is null (a root commit capture) or is neither mergeBase nor an ancestor of it; and the differing, missing, and extra paths. recordedBase is the base from capture.json. differing lists paths whose sections differ, missing lists paths only in the review, and extra lists paths only in the branch diff. A rename path reads "a/<old> b/<new>". reports lists which of reviewer.md, finder.md, and checker.md exist in directory as regular files.
  - Errors: no directory or mergeBase; a directory that is not .tau/workers/review-* or goes through a symlink; a missing, malformed, or newer capture.json; a missing recheck.diff; a mergeBase that is not a commit; any Git error.`;

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

const reuse = async (runtime: Runtime, parameters: PrInput) => {
  const root = await findRoot(runtime.cwd);

  const { directory, mergeBase } = parameters;
  const result = await readReuse(root, { directory, mergeBase });

  return { ...result };
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

  if (parameters.action === 'reuse') {
    return reuse(runtime, parameters);
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
    promptSnippet:
      "Prepare a pull request run, resolve the branch's pull request target, and check review reuse.",
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
