import type { Gap } from './capture.js';
import { isSupportedMode } from './patchBlobs.js';
import type { ShownMode, SupportedMode } from './patchBlobs.js';
import type { Snapshot } from './record.js';
import type { PinnedTarget } from './target.js';

export interface SnapshotFacts {
  skipped: Snapshot['skipped'];
  shownModes: { path: string; mode: ShownMode }[];
  presentModes: { path: string; mode: SupportedMode | undefined }[];
}

export interface EligibilityFacts {
  target: PinnedTarget['kind'];
  // A fix capture compared with the complete endpoint of its predecessor.
  chainedFix: boolean;
  gaps: Gap[];
  snapshot: SnapshotFacts | undefined;
}

export type EndpointEligibility =
  | { status: 'eligible' }
  | { status: 'unsupported' | 'incomplete'; reasons: string[] };

interface Limits {
  unsupported: string[];
  incomplete: string[];
}

const gapReason = (gap: Gap) => `The capture has a gap at ${gap.path} (${gap.kind}).`;

const gapEligibility = (gaps: Gap[]): EndpointEligibility => {
  const reasons = gaps.map((gap) => gapReason(gap));
  const unsupported = gaps.some((gap) => gap.kind !== 'unreadable');

  return { status: unsupported ? 'unsupported' : 'incomplete', reasons };
};

const modeReason = (path: string, mode: ShownMode) => {
  if (mode === 'symlink') {
    return `${path} is a symbolic link, which the snapshot does not save.`;
  }

  if (mode === 'gitlink') {
    return `${path} is a submodule, which the snapshot does not save.`;
  }

  return `The captured patch shows a mode for ${path} that Tau cannot read.`;
};

const snapshotLimits = (snapshot: SnapshotFacts): Limits => {
  const limits: Limits = { unsupported: [], incomplete: [] };

  for (const entry of snapshot.skipped) {
    const reason = `The snapshot skipped ${entry.path} (${entry.kind}).`;

    if (entry.kind === 'unreadable') {
      limits.incomplete.push(reason);
    } else {
      limits.unsupported.push(reason);
    }
  }

  for (const { path, mode } of snapshot.shownModes) {
    if (!isSupportedMode(mode)) {
      limits.unsupported.push(modeReason(path, mode));
    }
  }

  for (const { path, mode } of snapshot.presentModes) {
    if (mode === undefined) {
      limits.unsupported.push(`Neither the captured patch nor the base shows a mode for ${path}.`);
    }
  }

  return limits;
};

const limitedEligibility = (limits: Limits): EndpointEligibility => {
  if (limits.unsupported.length > 0) {
    return { status: 'unsupported', reasons: [...limits.unsupported, ...limits.incomplete] };
  }

  if (limits.incomplete.length > 0) {
    return { status: 'incomplete', reasons: limits.incomplete };
  }

  return { status: 'eligible' };
};

export const decideEndpoint = ({
  target,
  chainedFix,
  gaps,
  snapshot,
}: EligibilityFacts): EndpointEligibility => {
  if (target === 'fix' && !chainedFix) {
    return {
      status: 'unsupported',
      reasons: ['A fix capture of a predecessor with no complete endpoint records no endpoint.'],
    };
  }

  if (target === 'files' || target === 'rootCommit') {
    return { status: 'unsupported', reasons: [`A ${target} capture records no endpoint.`] };
  }

  if (gaps.length > 0) {
    return gapEligibility(gaps);
  }

  if (target !== 'workingTree') {
    return { status: 'eligible' };
  }

  if (snapshot === undefined) {
    return { status: 'incomplete', reasons: ['The capture saved no snapshot.'] };
  }

  return limitedEligibility(snapshotLimits(snapshot));
};
