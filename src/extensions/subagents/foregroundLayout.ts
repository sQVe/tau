import { requireObject, text } from './terminal.js';

export type Tree = string | { direction: 'right' | 'down'; first: Tree; second: Tree };
export type Branch = Exclude<Tree, string>;

export const leaves = (tree: Tree): string[] =>
  typeof tree === 'string' ? [tree] : [...leaves(tree.first), ...leaves(tree.second)];

export const append = (
  tree: Tree,
  target: string,
  added: string,
  direction: 'right' | 'down',
): Tree => {
  if (typeof tree === 'string') {
    return tree === target ? { direction, first: target, second: added } : tree;
  }

  return {
    ...tree,
    first: append(tree.first, target, added, direction),
    second: append(tree.second, target, added, direction),
  };
};

export const removePane = (tree: Tree, paneId: string): Tree | undefined => {
  if (typeof tree === 'string') {
    return tree === paneId ? undefined : tree;
  }

  const first = removePane(tree.first, paneId);
  const second = removePane(tree.second, paneId);

  if (first === undefined) {
    return second;
  }

  if (second === undefined) {
    return first;
  }

  return { ...tree, first, second };
};

export const edgeLeaf = (tree: Tree, direction: 'right' | 'down', last: boolean): string => {
  if (typeof tree === 'string') {
    return tree;
  }

  return edgeLeaf(tree.direction === direction && last ? tree.second : tree.first, direction, last);
};

export const isPositiveInteger = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) > 0;

// Herdr gives the first child the rounded share and the second the rest, with no divider cell.
export const splitLengths = (length: number, ratio: number) => {
  const first = Math.round(length * ratio);

  return { first, second: length - first };
};

export const panes = (layout: Record<string, unknown>) => {
  if (!Array.isArray(layout.panes)) {
    throw new TypeError('Missing herdr layout panes.');
  }

  return layout.panes.map(requireObject);
};

export const splits = (layout: Record<string, unknown>) => {
  if (!Array.isArray(layout.splits)) {
    throw new TypeError('Missing herdr layout splits.');
  }

  return layout.splits.map(requireObject);
};

export const frame = (layout: Record<string, unknown>) => ({
  workspace: layout.workspace_id,
  tab: layout.tab_id,
  area: layout.area,
  zoomed: layout.zoomed,
});

export const framesAreEqual = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean => JSON.stringify(frame(before)) === JSON.stringify(frame(after));

const containsHorizontally = (
  outer: Record<string, unknown>,
  inner: Record<string, unknown>,
): boolean =>
  Number(inner.x) >= Number(outer.x) &&
  Number(inner.x) + Number(inner.width) <= Number(outer.x) + Number(outer.width);

const containsVertically = (
  outer: Record<string, unknown>,
  inner: Record<string, unknown>,
): boolean =>
  Number(inner.y) >= Number(outer.y) &&
  Number(inner.y) + Number(inner.height) <= Number(outer.y) + Number(outer.height);

export const contains = (outer: Record<string, unknown>, inner: Record<string, unknown>) =>
  containsHorizontally(outer, inner) && containsVertically(outer, inner);

// Compare ordered child membership and ratios, not split paths or rectangles that change on sibling collapse.
const topologyAfterRemoval = (layout: Record<string, unknown>, removed?: string): string[] =>
  splits(layout)
    .flatMap((split) => {
      const bounds = requireObject(split.rect);
      const position = split.direction === 'right' ? 'x' : 'y';
      const dimension = split.direction === 'right' ? 'width' : 'height';
      const boundary = Number(bounds[position]) + Number(bounds[dimension]) * Number(split.ratio);
      const children = panes(layout).filter(
        (pane) => pane.pane_id !== removed && contains(bounds, requireObject(pane.rect)),
      );
      const first: string[] = [];
      const second: string[] = [];

      for (const pane of children) {
        const paneBounds = requireObject(pane.rect);
        const center = Number(paneBounds[position]) + Number(paneBounds[dimension]) / 2;
        const side = center < boundary ? first : second;
        side.push(text(pane.pane_id));
      }

      if (!first.length || !second.length) {
        return [];
      }

      return [
        JSON.stringify({
          direction: split.direction,
          ratio: split.ratio,
          first: first.toSorted(),
          second: second.toSorted(),
        }),
      ];
    })
    .toSorted();

export const splitShape = (split: Record<string, unknown>) =>
  JSON.stringify({ direction: split.direction, ratio: split.ratio, rect: split.rect });

const paneIdListsAreEqual = (expected: string[], actual: string[]): boolean =>
  JSON.stringify(expected) === JSON.stringify(actual);

const removalTopologyMatches = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  paneId: string,
): boolean =>
  splits(after).length === splits(before).length - 1 &&
  JSON.stringify(topologyAfterRemoval(before, paneId)) ===
    JSON.stringify(topologyAfterRemoval(after));

export const matchesOwnClose = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  paneId: string,
): boolean => {
  const expected = panes(before)
    .map((pane) => text(pane.pane_id))
    .filter((id) => id !== paneId)
    .toSorted();
  const actual = panes(after)
    .map((pane) => text(pane.pane_id))
    .toSorted();

  return (
    framesAreEqual(before, after) &&
    paneIdListsAreEqual(expected, actual) &&
    removalTopologyMatches(before, after, paneId)
  );
};
