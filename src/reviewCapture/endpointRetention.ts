import { basename } from 'node:path';

import { readGit } from '../git.js';
import { buildEndpoint, checkBinding, checkTransition } from './endpoint.js';
import type { Endpoint, EndpointCapture } from './endpoint.js';
import { buildChainedEndpoint } from './fixChain.js';
import type { RecordedEndpoint } from './record.js';
import type { PinnedTarget } from './target.js';

export interface RetainedEndpoint {
  ref: string;
  commit: string;
}

export interface PublishedEndpoint {
  endpoint: RecordedEndpoint;
  retained: RetainedEndpoint | undefined;
}

const refPrefix = 'refs/tau/review-captures/';

// The retention commit is internal, so it needs no user identity and no signature.
const commitEnvironment = {
  GIT_AUTHOR_NAME: 'Tau',
  GIT_AUTHOR_EMAIL: 'tau@localhost',
  GIT_COMMITTER_NAME: 'Tau',
  GIT_COMMITTER_EMAIL: 'tau@localhost',
};

const pinnedCommits = (target: PinnedTarget) => {
  if (target.kind === 'range') {
    return [target.from, target.to];
  }

  if (target.kind === 'workingTree') {
    return [target.base];
  }

  // A chained fix keeps the commit its chain started from.
  if (target.kind === 'fix' && target.predecessor !== undefined && target.base !== null) {
    return [target.base];
  }

  throw new Error(`A ${target.kind} capture records no endpoint.`);
};

const verifyTransition = async (
  root: string,
  endpoint: Extract<Endpoint, { status: 'complete' }>,
  capture: EndpointCapture,
) => {
  const mismatches = [
    ...(await checkBinding(root, endpoint, capture.target)),
    ...(await checkTransition(root, endpoint, capture.patch.toString('utf8'))),
  ];

  if (mismatches.length > 0) {
    throw new Error(
      `The endpoint does not match the captured target and patch. Nothing was written. Capture again.\n- ${mismatches.join('\n- ')}`,
    );
  }
};

// A commit of the endpoint tree on the pinned commits, so `git gc` keeps them and both trees while
// the ref exists. The ref must not exist yet, so a capture never takes over another capture's ref.
const retainEndpoint = async (
  root: string,
  ref: string,
  tree: string,
  parents: string[],
): Promise<RetainedEndpoint> => {
  const parentArguments = parents.flatMap((parent) => ['-p', parent]);

  const commit = await readGit(
    root,
    ['commit-tree', '--no-gpg-sign', tree, ...parentArguments, '-m', 'Tau review capture endpoint'],
    { environment: commitEnvironment },
  );

  await readGit(root, ['update-ref', '--no-deref', ref, commit, '']);

  return { ref, commit };
};

export const publishEndpoint = async (
  root: string,
  capture: EndpointCapture,
): Promise<PublishedEndpoint> => {
  const endpoint = buildChainedEndpoint(capture) ?? (await buildEndpoint(root, capture));

  if (endpoint.status !== 'complete') {
    return { endpoint, retained: undefined };
  }

  await verifyTransition(root, endpoint, capture);

  const ref = `${refPrefix}${basename(capture.directory)}`;
  const retained = await retainEndpoint(root, ref, endpoint.tree, pinnedCommits(capture.target));

  return { endpoint: { ...endpoint, ref }, retained };
};

// Deletes the ref only while it still points at this capture's commit.
export const releaseEndpoint = async (root: string, retained: RetainedEndpoint): Promise<void> => {
  await readGit(root, ['update-ref', '--no-deref', '-d', retained.ref, retained.commit]);
};
