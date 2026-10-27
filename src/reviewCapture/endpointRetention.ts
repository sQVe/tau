import { basename } from 'node:path';

import { readGit } from '../git.js';
import type { Gap } from './capture.js';
import { buildEndpoint, checkTransition } from './endpoint.js';
import type { Endpoint } from './endpoint.js';
import type { RecordedEndpoint, Snapshot } from './record.js';
import type { PinnedTarget } from './target.js';

export interface EndpointCapture {
  directory: string;
  target: PinnedTarget;
  gaps: Gap[];
  patch: Buffer;
  snapshot: Snapshot | undefined;
}

export interface RetainedEndpoint {
  ref: string;
  commit: string;
}

export interface PublishedEndpoint {
  endpoint: RecordedEndpoint;
  retained: RetainedEndpoint | undefined;
}

type LimitedEndpoint = Exclude<Endpoint, { status: 'complete' }>;

type EndpointTarget = Extract<PinnedTarget, { kind: 'range' | 'workingTree' }>;

const refPrefix = 'refs/tau/review-captures/';

// The retention commit is internal, so it needs no user identity and no signature.
const commitEnvironment = {
  GIT_AUTHOR_NAME: 'Tau',
  GIT_AUTHOR_EMAIL: 'tau@localhost',
  GIT_COMMITTER_NAME: 'Tau',
  GIT_COMMITTER_EMAIL: 'tau@localhost',
};

const gapReason = (gap: Gap) => `The capture has a gap at ${gap.path} (${gap.kind}).`;

// An unreadable path may be read by a later capture. Every other gap is content the patch never
// shows, so no capture of that target can prove its endpoint.
const gapEndpoint = (gaps: Gap[]): LimitedEndpoint => {
  const reasons = gaps.map((gap) => gapReason(gap));
  const unsupported = gaps.some((gap) => gap.kind !== 'unreadable');

  return { status: unsupported ? 'unsupported' : 'incomplete', reasons };
};

const unsupportedTarget = (target: PinnedTarget): LimitedEndpoint => ({
  status: 'unsupported',
  reasons: [`A ${target.kind} capture records no endpoint.`],
});

const buildCaptureEndpoint = (
  root: string,
  target: EndpointTarget,
  capture: EndpointCapture,
): Promise<Endpoint> => {
  if (target.kind === 'range') {
    return buildEndpoint(root, { kind: 'range', from: target.from, to: target.to });
  }

  if (capture.snapshot === undefined) {
    return Promise.resolve({ status: 'incomplete', reasons: ['The capture saved no snapshot.'] });
  }

  return buildEndpoint(root, {
    kind: 'workingTree',
    directory: capture.directory,
    base: target.base,
    snapshot: capture.snapshot,
    patch: capture.patch.toString('utf8'),
  });
};

const baseCommit = (target: EndpointTarget) =>
  target.kind === 'range' ? target.from : target.base;

const verifyTransition = async (
  root: string,
  endpoint: Extract<Endpoint, { status: 'complete' }>,
  patch: Buffer,
) => {
  const mismatches = await checkTransition(root, endpoint, patch.toString('utf8'));

  if (mismatches.length > 0) {
    throw new Error(
      `The endpoint does not match the captured patch. Nothing was written. Capture again.\n- ${mismatches.join('\n- ')}`,
    );
  }
};

// A commit of the endpoint tree on its base, so `git gc` keeps both trees while the ref exists.
// The ref must not exist yet, so a capture never takes over another capture's ref.
const retainEndpoint = async (
  root: string,
  ref: string,
  tree: string,
  base: string,
): Promise<RetainedEndpoint> => {
  const commit = await readGit(
    root,
    ['commit-tree', '--no-gpg-sign', tree, '-p', base, '-m', 'Tau review capture endpoint'],
    { environment: commitEnvironment },
  );

  await readGit(root, ['update-ref', '--no-deref', ref, commit, '']);

  return { ref, commit };
};

// Builds the endpoint of a verified capture. A complete endpoint must match the saved patch and is
// kept by a ref; a mismatch fails the capture.
export const publishEndpoint = async (
  root: string,
  capture: EndpointCapture,
): Promise<PublishedEndpoint> => {
  const { target } = capture;

  if (target.kind !== 'range' && target.kind !== 'workingTree') {
    return { endpoint: unsupportedTarget(target), retained: undefined };
  }

  if (capture.gaps.length > 0) {
    return { endpoint: gapEndpoint(capture.gaps), retained: undefined };
  }

  const endpoint = await buildCaptureEndpoint(root, target, capture);

  if (endpoint.status !== 'complete') {
    return { endpoint, retained: undefined };
  }

  await verifyTransition(root, endpoint, capture.patch);

  const ref = `${refPrefix}${basename(capture.directory)}`;
  const retained = await retainEndpoint(root, ref, endpoint.tree, baseCommit(target));

  return { endpoint: { ...endpoint, ref }, retained };
};

// Deletes the ref only while it still points at this capture's commit.
export const releaseEndpoint = async (root: string, retained: RetainedEndpoint): Promise<void> => {
  await readGit(root, ['update-ref', '--no-deref', '-d', retained.ref, retained.commit]);
};
