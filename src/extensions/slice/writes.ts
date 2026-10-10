import type { Draft, Plan } from './draft.js';

export interface LinearChild {
  identifier: string;
  title: string;
  description: string;
  url: string;
  sortOrder: number;
  completed: boolean;
  canceled: boolean;
  merged: boolean;
  blockedBy: string[];
}

export interface LinearContainer {
  id: string;
  identifier: string;
  completed: boolean;
  merged: boolean;
  title: string;
  description: string;
  url: string;
  team: { id: string; key: string };
  project: { id: string; name: string } | null;
  children: LinearChild[];
}

export interface OrderedSlice {
  identifier: string;
  sortOrder: number;
  merged: boolean;
  completed: boolean;
}

export type SliceWrite =
  | { kind: 'createContainer' }
  | { kind: 'updateContainer'; identifier: string; title: boolean; description: boolean }
  | { kind: 'createSlice'; number: number; sortOrder: number }
  | {
      kind: 'updateSlice';
      number: number;
      identifier: string;
      title: boolean;
      description: boolean;
    }
  | { kind: 'addBlockedBy'; number: number; blocker: number }
  | { kind: 'removeBlockedBy'; identifier: string; blocker: string }
  | { kind: 'moveSlice'; identifier: string; sortOrder: number };

export interface WritePlan {
  writes: SliceWrite[];
  problems: string[];
  dropped: string[];
}

const routeProblems = (draft: Draft, container: LinearContainer) => {
  const { route } = draft.plan;
  const project = container.project?.name ?? null;
  const sameTeam = container.team.key === route.team;

  if (sameTeam && project === route.project) {
    return [];
  }

  const containerProject = project === null ? 'no project' : `project ${project}`;
  const routeProject = route.project === null ? 'no project' : `project ${route.project}`;

  return [
    `${container.identifier} is in team ${container.team.key} and ${containerProject}, but the draft routes to team ${route.team} and ${routeProject}.`,
  ];
};

const childProblems = (draft: Draft, container: LinearContainer) => {
  const problems: string[] = [];
  const children = new Map(container.children.map((child) => [child.identifier, child]));
  const recorded = new Set(draft.plan.slices.map((slice) => slice.identifier));

  for (const [index, slice] of draft.plan.slices.entries()) {
    if (slice.identifier !== null && !children.has(slice.identifier)) {
      problems.push(
        `Slice ${index + 1} records ${slice.identifier}, which is not a child of ${container.identifier}.`,
      );
    }

    const sameTitle = container.children.find(
      (child) => child.title === slice.title && !recorded.has(child.identifier),
    );

    if (slice.identifier === null && sameTitle !== undefined) {
      problems.push(
        `Slice ${index + 1} has no identifier, but ${sameTitle.identifier} under ${container.identifier} has the same title. An earlier create may have succeeded. Record it in the draft or rename one of them.`,
      );
    }
  }

  return problems;
};

const containerTitleProblems = (draft: Draft, titleMatches: readonly string[]) =>
  titleMatches.map(
    (identifier) =>
      `The draft has no container identifier, but ${identifier} is an open issue in team ${draft.plan.route.team} with the title "${draft.plan.container.title}". An earlier create may have succeeded. Record it in the draft or rename the container.`,
  );

const completedProblem = (identifier: string) =>
  `${identifier} is completed in Linear, but no linked pull request is merged. Ask the user how to treat it.`;

const blockerIdentifier = (draft: Draft, blocker: number) =>
  draft.plan.slices[blocker - 1]?.identifier ?? null;

// A merged or completed slice is never written, so it cannot move.
const isFixed = (slice: OrderedSlice) => slice.merged || slice.completed;

const nextFixedOrder = (slices: readonly (OrderedSlice | undefined)[], start: number) =>
  slices.slice(start).find((slice) => slice !== undefined && isFixed(slice))?.sortOrder ??
  Number.POSITIVE_INFINITY;

// A merged or completed slice keeps its place, and so does an open one between its neighbors.
const keepsPlace = (
  slices: readonly (OrderedSlice | undefined)[],
  index: number,
  previous: number,
) => {
  const slice = slices[index];

  if (slice === undefined) {
    return false;
  }

  const between = slice.sortOrder > previous && slice.sortOrder < nextFixedOrder(slices, index + 1);

  return isFixed(slice) || between;
};

// The first later slice that keeps its place bounds a placed slice, so placing one never pushes a
// later slice out of place.
const upperOrder = (
  slices: readonly (OrderedSlice | undefined)[],
  start: number,
  previous: number,
) => {
  for (let index = start; index < slices.length; index += 1) {
    const slice = slices[index];

    if (slice !== undefined && keepsPlace(slices, index, previous)) {
      return slice.sortOrder;
    }
  }

  return Number.POSITIVE_INFINITY;
};

const placeBetween = (lower: number, upper: number) => {
  if (lower === Number.NEGATIVE_INFINITY) {
    return upper === Number.POSITIVE_INFINITY ? 0 : upper - 1;
  }

  return upper === Number.POSITIVE_INFINITY ? lower + 1 : (lower + upper) / 2;
};

// Takes the slices in plan order, undefined for a slice the plan creates, and returns the sort order
// each one gets: one for every new slice and every open slice that is out of place, undefined for a
// slice that keeps its place. Merged and completed slices keep their place, so one that is itself
// out of order stays wrong.
export const plannedSortOrders = (
  slicesInPlanOrder: readonly (OrderedSlice | undefined)[],
): (number | undefined)[] => {
  const orders: (number | undefined)[] = [];
  let previous = Number.NEGATIVE_INFINITY;

  for (const [index, slice] of slicesInPlanOrder.entries()) {
    if (slice !== undefined && keepsPlace(slicesInPlanOrder, index, previous)) {
      orders.push(undefined);
      previous = slice.sortOrder;

      continue;
    }

    const sortOrder = placeBetween(previous, upperOrder(slicesInPlanOrder, index + 1, previous));

    orders.push(sortOrder);
    previous = sortOrder;
  }

  return orders;
};

const sliceWrites = (draft: Draft, container: LinearContainer | undefined) => {
  const writes: SliceWrite[] = [];
  const problems: string[] = [];
  const children = new Map(container?.children.map((child) => [child.identifier, child]));
  const siblings = new Set(children.keys());

  const slots = draft.plan.slices.map((slice) =>
    slice.identifier === null ? undefined : children.get(slice.identifier),
  );

  const sortOrders = plannedSortOrders(slots);

  for (const [index, slice] of draft.plan.slices.entries()) {
    const number = index + 1;
    const child = slots[index];
    const sortOrder = sortOrders[index];

    if (child === undefined) {
      writes.push({ kind: 'createSlice', number, sortOrder: sortOrder ?? 0 });

      writes.push(
        ...slice.blockedBy.map((blocker) => ({ kind: 'addBlockedBy' as const, number, blocker })),
      );

      continue;
    }

    if (child.merged) {
      continue;
    }

    const changedTitle = child.title !== slice.title;
    const changedDescription = child.description !== draft.sliceBodies[index];

    const added = slice.blockedBy.filter((blocker) => {
      const identifier = blockerIdentifier(draft, blocker);

      return identifier === null || !child.blockedBy.includes(identifier);
    });

    const wanted = new Set(slice.blockedBy.map((blocker) => blockerIdentifier(draft, blocker)));

    const removed = child.blockedBy.filter(
      (blocker) => siblings.has(blocker) && !wanted.has(blocker),
    );

    const sliceChanges: SliceWrite[] = [];

    if (changedTitle || changedDescription) {
      sliceChanges.push({
        kind: 'updateSlice',
        number,
        identifier: child.identifier,
        title: changedTitle,
        description: changedDescription,
      });
    }

    sliceChanges.push(
      ...added.map((blocker) => ({ kind: 'addBlockedBy' as const, number, blocker })),
    );

    sliceChanges.push(
      ...removed.map((blocker) => ({
        kind: 'removeBlockedBy' as const,
        identifier: child.identifier,
        blocker,
      })),
    );

    if (child.completed && sliceChanges.length > 0) {
      problems.push(completedProblem(child.identifier));
    }

    writes.push(...sliceChanges);

    if (sortOrder !== undefined) {
      writes.push({ kind: 'moveSlice', identifier: child.identifier, sortOrder });
    }
  }

  return { writes, problems };
};

const containerWrites = (draft: Draft, container: LinearContainer | undefined) => {
  if (container === undefined) {
    return { writes: [{ kind: 'createContainer' } as const], problems: [] };
  }

  const title = container.title !== draft.plan.container.title;
  const description = container.description !== draft.containerBody;
  const changed = title || description;

  if (container.merged || !changed) {
    return { writes: [], problems: [] };
  }

  const writes = [
    { kind: 'updateContainer' as const, identifier: container.identifier, title, description },
  ];

  return { writes, problems: container.completed ? [completedProblem(container.identifier)] : [] };
};

const writeRanks: Record<SliceWrite['kind'], number> = {
  createContainer: 0,
  createSlice: 0,
  updateContainer: 1,
  updateSlice: 1,
  addBlockedBy: 2,
  removeBlockedBy: 2,
  moveSlice: 3,
};

// Lists the Linear writes that make Linear match the draft, in the order to apply them: every create,
// then updates, then relations, then sort order moves, so a relation never names a slice that does
// not exist yet. Each new slice is created at its plan position. A slice counts as present only
// through the identifier the draft records. Merged tickets are never written.
// titleMatches lists the open issues in the route whose title is the container title.
export const planWrites = (
  draft: Draft,
  container: LinearContainer | undefined,
  titleMatches: readonly string[],
): WritePlan => {
  const planned = new Set(draft.plan.slices.map((slice) => slice.identifier));

  const dropped =
    container?.children
      .filter((child) => !planned.has(child.identifier) && !child.canceled)
      .map((child) => child.identifier) ?? [];

  const fixedProblems =
    container === undefined
      ? containerTitleProblems(draft, titleMatches)
      : [...routeProblems(draft, container), ...childProblems(draft, container)];

  const top = containerWrites(draft, container);
  const slices = sliceWrites(draft, container);

  const writes = [...top.writes, ...slices.writes].toSorted(
    (left, right) => writeRanks[left.kind] - writeRanks[right.kind],
  );

  return {
    writes,
    problems: [...fixedProblems, ...top.problems, ...slices.problems],
    dropped,
  };
};

export const isInPlanOrder = (slicesInPlanOrder: readonly OrderedSlice[]): boolean =>
  slicesInPlanOrder.every((slice, index) => {
    const previous = slicesInPlanOrder[index - 1];

    return previous === undefined || slice.sortOrder > previous.sortOrder;
  });

const sliceLabel = (plan: Plan, number: number) =>
  `slice ${number} "${plan.slices[number - 1]?.title ?? ''}"`;

const changedParts = (
  write: { title: boolean; description: boolean },
  draftPart: { title: string; file: string },
) => {
  const parts: string[] = [];

  if (write.title) {
    parts.push(`title to "${draftPart.title}"`);
  }

  if (write.description) {
    parts.push(`description from ${draftPart.file}`);
  }

  return parts.join(' and ');
};

const updatedPart = (
  plan: Plan,
  write: SliceWrite & { kind: 'updateContainer' | 'updateSlice' },
) =>
  write.kind === 'updateContainer'
    ? plan.container
    : (plan.slices[write.number - 1] ?? { title: '', file: '' });

export const describeWrite = (plan: Plan, write: SliceWrite): string => {
  if (write.kind === 'createContainer') {
    const project =
      plan.route.project === null ? 'with no project' : `and project ${plan.route.project}`;

    return `Create container "${plan.container.title}" in team ${plan.route.team} ${project}`;
  }

  if (write.kind === 'createSlice') {
    return `Create ${sliceLabel(plan, write.number)} under the container`;
  }

  if (write.kind === 'addBlockedBy') {
    return `Mark slice ${write.number} blocked by slice ${write.blocker}`;
  }

  if (write.kind === 'moveSlice') {
    return `Move ${write.identifier} into plan order`;
  }

  if (write.kind === 'removeBlockedBy') {
    return `Remove ${write.identifier} blocked by ${write.blocker}`;
  }

  return `Update the ${changedParts(write, updatedPart(plan, write))} of ${write.identifier}`;
};
