import { readGit, runGit } from '../../git.js';
import { readContainer, readIssuePullRequests } from './linear.js';
import { decidePick } from './startPickDecisions.js';
import type { PickSlice, StartPick } from './startPickDecisions.js';
import type { Runtime } from './state.js';

const readDefaultBranch = async (runtime: Runtime) => {
  const options = runtime.signal === undefined ? {} : { signal: runtime.signal };

  // An explicit refspec also updates a stack parent's branch in a clone with a narrowed refspec.
  await readGit(runtime.root, ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'], options);

  // Fetch leaves origin/HEAD unchanged, so a renamed default branch would still read the old name.
  await runGit(runtime.root, ['remote', 'set-head', 'origin', '--auto'], options);

  const symbolic = await runGit(
    runtime.root,
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    options,
  );

  if (symbolic.exitCode === 0) {
    const reference = symbolic.stdout.toString('utf8').trim();

    if (!reference.startsWith('origin/') || reference === 'origin/') {
      throw new Error('git symbolic-ref returned an invalid origin default branch.');
    }

    return reference.slice('origin/'.length);
  }

  if (symbolic.exitCode !== 1) {
    throw new Error(`git symbolic-ref failed: ${symbolic.stderr.trim()}`);
  }

  const remote = await readGit(runtime.root, ['ls-remote', '--symref', 'origin', 'HEAD'], options);
  const branch = /^ref: refs\/heads\/(.+)\s+HEAD$/mu.exec(remote)?.[1];

  if (branch === undefined) {
    throw new Error('git ls-remote returned no origin default branch.');
  }

  return branch;
};

export const readStartPick = async (runtime: Runtime, identifier: string): Promise<StartPick> => {
  const states = new Map<string, Promise<string>>();
  const issue = await readContainer(runtime.exec, runtime.root, identifier, states);

  if (issue === undefined) {
    throw new Error(`Linear has no issue ${identifier}.`);
  }

  const container = issue.children.length > 0;
  const candidates = container ? issue.children : [issue];
  const blockerIdentifiers = new Set(candidates.flatMap((candidate) => candidate.blockedBy));

  const knownPullRequests = new Map(
    [issue, ...issue.children].map((candidate) => [candidate.identifier, candidate.pullRequests]),
  );

  await Promise.all(
    [...blockerIdentifiers].map(async (blockerIdentifier) => {
      if (knownPullRequests.has(blockerIdentifier)) {
        return;
      }

      const blocker = await readIssuePullRequests(
        runtime.exec,
        runtime.root,
        blockerIdentifier,
        states,
      );

      if (blocker === undefined) {
        throw new Error(`Linear has no blocker ${blockerIdentifier}.`);
      }

      knownPullRequests.set(blockerIdentifier, blocker);
    }),
  );

  const slices: PickSlice[] = candidates.map((candidate) => ({
    identifier: candidate.identifier,
    title: candidate.title,
    url: candidate.url,
    branchName: candidate.branchName,
    description: candidate.description,
    completed: candidate.completed,
    canceled: candidate.canceled,
    pullRequests: candidate.pullRequests,
    team: issue.team,
    blockers: candidate.blockedBy.map((blockerIdentifier) => {
      const blocker = knownPullRequests.get(blockerIdentifier);

      if (blocker === undefined) {
        throw new Error(`Missing blocker evidence for ${blockerIdentifier}.`);
      }

      return { identifier: blockerIdentifier, pullRequests: blocker };
    }),
  }));

  const defaultBranch = await readDefaultBranch(runtime);

  return decidePick({ slices, container, defaultBranch });
};
