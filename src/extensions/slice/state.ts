import { createHash } from 'node:crypto';

import type { Draft } from './draft.js';
import { readDraft } from './draft.js';
import { findOpenIssues, readContainer } from './linear.js';
import type { Exec } from './linear.js';
import { isInPlanOrder, planWrites } from './writes.js';
import type { LinearContainer, OrderedSlice, WritePlan } from './writes.js';

export interface Runtime {
  exec: Exec;
  root: string;
  signal: AbortSignal | undefined;
}

export interface SliceState {
  directory: string;
  draft: Draft | undefined;
  container: LinearContainer | undefined;
  writePlan: WritePlan;
  orderInPlace: boolean;
  stateToken: string;
}

export const slicesPath = 'slices';

export const orderedSlices = (draft: Draft, container: LinearContainer): OrderedSlice[] => {
  const children = new Map(container.children.map((child) => [child.identifier, child]));

  return draft.plan.slices.flatMap((slice) => {
    const child = slice.identifier === null ? undefined : children.get(slice.identifier);

    return child === undefined ? [] : [child];
  });
};

// Without a recorded identifier, an open issue with the container title may come from a create
// whose output was lost.
const readTitleMatches = async (
  runtime: Runtime,
  draft: Draft | undefined,
  identifier: string | undefined,
) => {
  if (draft === undefined || identifier !== undefined) {
    return [];
  }

  return findOpenIssues(runtime.exec, runtime.root, {
    ...draft.plan.route,
    title: draft.plan.container.title,
  });
};

const containerIdentifier = (draft: Draft | undefined, requested: string | undefined) => {
  const saved = draft?.plan.container.identifier ?? undefined;

  if (saved !== undefined && requested !== undefined && saved !== requested) {
    throw new Error(`The draft records container ${saved}, not ${requested}.`);
  }

  return saved ?? requested;
};

// Reads the draft, its bodies, and Linear once. The token covers everything the writes depend on.
export const readState = async (
  runtime: Runtime,
  directory: string,
  requested: string | undefined,
): Promise<SliceState> => {
  const draft = await readDraft(directory);
  const identifier = containerIdentifier(draft, requested);

  const container =
    identifier === undefined
      ? undefined
      : await readContainer(runtime.exec, runtime.root, identifier);

  if (identifier !== undefined && container === undefined) {
    throw new Error(`Linear has no issue ${identifier}.`);
  }

  const titleMatches = await readTitleMatches(runtime, draft, identifier);

  const writePlan =
    draft === undefined
      ? { writes: [], problems: [], dropped: [] }
      : planWrites(draft, container, titleMatches);

  const orderInPlace =
    draft === undefined || container === undefined
      ? true
      : isInPlanOrder(orderedSlices(draft, container));

  const stateToken = createHash('sha256')
    .update(JSON.stringify({ directory, draft, container, titleMatches }))
    .digest('hex');

  return { directory, draft, container, writePlan, orderInPlace, stateToken };
};
