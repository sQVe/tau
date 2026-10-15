import type { StackView, StackViewRead } from './checkDecisions.js';
import { failedExit, malformedOutput, readFailed, readOk } from './readResult.js';
import type { CommandOutput, FailedRead, Read } from './readResult.js';

export interface HistoryLayer {
  name: string;
  isMerged: boolean;
  isQueued: boolean;
}

export interface LayerParents {
  branch: string;
  // The first unmerged branch below, or the trunk.
  newParent: string;
  // The local branch directly below, merged or not, or the trunk for the bottom branch.
  oldParent: string;
}

export type CherryMark = '+' | '-';

export interface PublishedReads {
  // The commits `git log <tip>..<remote>/<branch>` lists.
  unseen: Read<number>;
  // Whether the branch is an ancestor of its remote branch. null for a branch rebased since its
  // last push, which cannot be only behind.
  ancestor: Read<boolean> | null;
  // `git cherry <tip> <remote>/<branch> <remote>/<new parent>`.
  newCherry: Read<CherryMark[]>;
  // `git cherry <remote>/<branch> <tip> <old parent>`.
  oldCherry: Read<CherryMark[]>;
}

export interface LayerFacts {
  // The remote tip, or null when the remote has no such branch.
  remoteTip: Read<string | null>;
  // null when the remote has no such branch.
  published: PublishedReads | null;
}

type LayerStatus = 'unpublished' | 'current' | 'behind' | 'rewritten' | 'diverged' | 'unknown';

export interface LayerDecision {
  status: LayerStatus;
  remoteTip: string | null;
  reason: string | null;
}

// Active branches are those not merged and not queued. A queued branch below still counts as the
// parent, since GitHub has not merged it.
export const activeLayerParents = (
  trunk: string,
  layers: readonly HistoryLayer[],
): LayerParents[] =>
  layers.flatMap((layer, index) => {
    if (layer.isMerged || layer.isQueued) {
      return [];
    }

    const newParent = layers.slice(0, index).findLast((below) => !below.isMerged)?.name ?? trunk;
    const oldParent = layers[index - 1]?.name ?? trunk;

    return [{ branch: layer.name, newParent, oldParent }];
  });

// `git rev-parse --verify --quiet` prints nothing and exits 1 for a missing ref.
export const readRemoteTip = (command: string, output: CommandOutput): Read<string | null> => {
  if (output.exitCode === 1 && output.stdout.trim() === '') {
    return readOk(null);
  }

  if (output.exitCode !== 0) {
    return failedExit(command, output);
  }

  const tip = output.stdout.trim();

  return /^[\da-f]{40,64}$/u.test(tip) ? readOk(tip) : malformedOutput(command, output);
};

export const readCommitCount = (command: string, output: CommandOutput): Read<number> => {
  if (output.exitCode !== 0) {
    return failedExit(command, output);
  }

  const lines = output.stdout.split('\n').filter((line) => line.trim() !== '');

  return readOk(lines.length);
};

// `git merge-base --is-ancestor` exits 0 for an ancestor and 1 for a branch that is not.
export const readAncestor = (command: string, output: CommandOutput): Read<boolean> => {
  if (output.exitCode === 0 || output.exitCode === 1) {
    return readOk(output.exitCode === 0);
  }

  return failedExit(command, output);
};

const isCherryMark = (value: string | undefined): value is CherryMark =>
  value === '+' || value === '-';

export const readCherry = (command: string, output: CommandOutput): Read<CherryMark[]> => {
  if (output.exitCode !== 0) {
    return failedExit(command, output);
  }

  const lines = output.stdout.split('\n').filter((line) => line.trim() !== '');
  const marks: CherryMark[] = [];

  for (const line of lines) {
    const mark = /^([+-]) [\da-f]{7,64}$/u.exec(line.trim())?.[1];

    if (!isCherryMark(mark)) {
      return malformedOutput(command, output);
    }

    marks.push(mark);
  }

  return readOk(marks);
};

const unknown = (remoteTip: string | null, reason: string): LayerDecision => ({
  status: 'unknown',
  remoteTip,
  reason,
});

const settled = (status: LayerStatus, remoteTip: string): LayerDecision => ({
  status,
  remoteTip,
  reason: null,
});

// Every commit on both sides has a patch-equivalent on the other. Empty output proves nothing: git
// cherry prints no line when the range is empty, so a rewrite is not shown.
const isOnlyEquivalent = (marks: readonly CherryMark[]) =>
  marks.length > 0 && marks.every((mark) => mark === '-');

const unknownFromRead = (remoteTip: string | null, read: FailedRead): LayerDecision =>
  unknown(remoteTip, `${read.command} ${read.problem}`);

const decideRewrite = (
  tip: string,
  newCherry: Read<CherryMark[]>,
  oldCherry: Read<CherryMark[]>,
): LayerDecision => {
  if (!newCherry.ok) {
    return unknownFromRead(tip, newCherry);
  }

  if (!oldCherry.ok) {
    return unknownFromRead(tip, oldCherry);
  }

  const rewritten = isOnlyEquivalent(newCherry.value) && isOnlyEquivalent(oldCherry.value);

  return settled(rewritten ? 'rewritten' : 'diverged', tip);
};

const decidePublished = (tip: string, reads: PublishedReads): LayerDecision => {
  const { unseen, ancestor, newCherry, oldCherry } = reads;

  if (!unseen.ok) {
    return unknownFromRead(tip, unseen);
  }

  if (unseen.value === 0) {
    return settled('current', tip);
  }

  if (ancestor !== null && !ancestor.ok) {
    return unknownFromRead(tip, ancestor);
  }

  if (ancestor?.value === true) {
    return settled('behind', tip);
  }

  return decideRewrite(tip, newCherry, oldCherry);
};

// The remote-history check of one active branch. The reads are the ones the stack skill names, in
// its order. A read counts only when the decision reaches it.
export const decideLayer = (facts: LayerFacts): LayerDecision => {
  const { remoteTip, published } = facts;

  if (!remoteTip.ok) {
    return unknownFromRead(null, remoteTip);
  }

  if (remoteTip.value === null || published === null) {
    return { status: 'unpublished', remoteTip: null, reason: null };
  }

  return decidePublished(remoteTip.value, published);
};

// The remote-history check needs the branches of `gh stack view --json`. Any other result stops it.
export const requireStackView = (stackView: StackViewRead): Read<StackView> => {
  const command = 'gh stack view --json';

  if (stackView.exitCode !== 0) {
    const status =
      stackView.exitCode === null ? 'did not finish' : `exited with code ${stackView.exitCode}`;

    return readFailed(command, status);
  }

  return stackView.view ?? readFailed(command, 'printed no output');
};
