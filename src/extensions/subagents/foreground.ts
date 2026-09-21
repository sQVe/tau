import { listTerminals, object, result, text } from './terminal.js';
import type { TerminalCall, TerminalLocation } from './terminal.js';

export interface Rectangle {
  width: number;
  height: number;
}

// Leave room for pane borders and status rows around 80 columns and 20 useful rows.
export const minimumPane = { width: 82, height: 24 };
export const rectangle = (value: unknown): Rectangle => {
  const bounds = object(value);

  if (
    !Number.isSafeInteger(bounds.width) ||
    Number(bounds.width) <= 0 ||
    !Number.isSafeInteger(bounds.height) ||
    Number(bounds.height) <= 0
  ) {
    throw new Error('Invalid herdr pane dimensions.');
  }

  return { width: Number(bounds.width), height: Number(bounds.height) };
};
export const isUseful = (bounds: Rectangle): boolean =>
  bounds.width >= minimumPane.width && bounds.height >= minimumPane.height;

// Herdr gives the first child the rounded share and the second the rest, with no divider cell.
const splitLengths = (length: number, ratio: number) => {
  const first = Math.round(length * ratio);

  return { first, second: length - first };
};

export const splitDirection = (bounds: Rectangle): 'right' | 'down' | undefined => {
  const right = isUseful({ width: splitLengths(bounds.width, 0.5).second, height: bounds.height });
  const down = isUseful({ width: bounds.width, height: splitLengths(bounds.height, 0.5).second });

  if (right && (!down || bounds.width / minimumPane.width >= bounds.height / minimumPane.height)) {
    return 'right';
  }

  return down ? 'down' : undefined;
};

const panes = (layout: Record<string, unknown>) => {
  if (!Array.isArray(layout.panes)) {
    throw new TypeError('Missing herdr layout panes.');
  }

  return layout.panes.map(object);
};
const splits = (layout: Record<string, unknown>) => {
  if (!Array.isArray(layout.splits)) {
    throw new TypeError('Missing herdr layout splits.');
  }

  return layout.splits.map(object);
};
const frame = (layout: Record<string, unknown>) => ({
  workspace: layout.workspace_id,
  tab: layout.tab_id,
  area: layout.area,
  zoomed: layout.zoomed,
});
export const layoutShape = (layout: Record<string, unknown>): string => {
  if (typeof layout.zoomed !== 'boolean') {
    throw new TypeError('Missing herdr zoom state.');
  }

  return JSON.stringify({
    ...frame(layout),
    splits: layout.splits,
    panes: panes(layout).map((pane) => ({ paneId: text(pane.pane_id), rectangle: pane.rect })),
  });
};

type Tree = string | { direction: 'right' | 'down'; first: Tree; second: Tree };
type Branch = Exclude<Tree, string>;
const leaves = (tree: Tree): string[] =>
  typeof tree === 'string' ? [tree] : [...leaves(tree.first), ...leaves(tree.second)];
const append = (tree: Tree, target: string, added: string, direction: 'right' | 'down'): Tree => {
  if (typeof tree === 'string') {
    return tree === target ? { direction, first: target, second: added } : tree;
  }

  return {
    ...tree,
    first: append(tree.first, target, added, direction),
    second: append(tree.second, target, added, direction),
  };
};
const removePane = (tree: Tree, paneId: string): Tree | undefined => {
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

const edgeLeaf = (tree: Tree, direction: 'right' | 'down', last: boolean): string => {
  if (typeof tree === 'string') {
    return tree;
  }

  return edgeLeaf(tree.direction === direction && last ? tree.second : tree.first, direction, last);
};
const contains = (outer: Record<string, unknown>, inner: Record<string, unknown>) =>
  Number(inner.x) >= Number(outer.x) &&
  Number(inner.y) >= Number(outer.y) &&
  Number(inner.x) + Number(inner.width) <= Number(outer.x) + Number(outer.width) &&
  Number(inner.y) + Number(inner.height) <= Number(outer.y) + Number(outer.height);

// Find only the split enclosing the recorded Tau children. Never address a cached split path.
const branchSplit = (tree: Branch, layout: Record<string, unknown>) => {
  const children = leaves(tree).map((paneId) =>
    panes(layout).find((pane) => pane.pane_id === paneId),
  );
  const candidates = splits(layout)
    .filter(
      (split) =>
        split.direction === tree.direction &&
        children.every((child) => child && contains(object(split.rect), object(child.rect))),
    )
    .toSorted(
      (left, right) =>
        Number(object(left.rect).width) * Number(object(left.rect).height) -
        Number(object(right.rect).width) * Number(object(right.rect).height),
    );
  const split = candidates[0];

  if (!split) {
    throw new Error('Owned foreground split is unavailable.');
  }

  return split;
};

interface Adjustment {
  branch: Branch;
  ratio: number;
}
export interface ForegroundPlan {
  tree: Tree;
  target: string;
  adjustments: Adjustment[];
}
const distribute = (
  tree: Tree,
  bounds: Rectangle,
  target: string,
  adjustments: Adjustment[],
): boolean => {
  if (typeof tree === 'string') {
    return tree === target ? splitDirection(bounds) !== undefined : isUseful(bounds);
  }

  const first = leaves(tree.first);
  const second = leaves(tree.second);
  const firstWeight = first.length + Number(first.includes(target));
  const secondWeight = second.length + Number(second.includes(target));
  const ratio = firstWeight / (firstWeight + secondWeight);

  // Herdr clamps ratios to this range. Do not plan dimensions it cannot reproduce.
  if (ratio < 0.1 || ratio > 0.9) {
    return false;
  }

  adjustments.push({ branch: tree, ratio });
  const axis = tree.direction === 'right' ? 'width' : 'height';
  const { first: firstLength, second: secondLength } = splitLengths(bounds[axis], ratio);

  return (
    distribute(tree.first, { ...bounds, [axis]: firstLength }, target, adjustments) &&
    distribute(tree.second, { ...bounds, [axis]: secondLength }, target, adjustments)
  );
};
const splitShape = (split: Record<string, unknown>) =>
  JSON.stringify({ direction: split.direction, ratio: split.ratio, rect: split.rect });

// Compare ordered child membership and ratios, not split paths or rectangles that change on sibling collapse.
const topologyAfterRemoval = (layout: Record<string, unknown>, removed?: string): string[] =>
  splits(layout)
    .flatMap((split) => {
      const bounds = object(split.rect);
      const position = split.direction === 'right' ? 'x' : 'y';
      const dimension = split.direction === 'right' ? 'width' : 'height';
      const boundary = Number(bounds[position]) + Number(bounds[dimension]) * Number(split.ratio);
      const children = panes(layout).filter(
        (pane) => pane.pane_id !== removed && contains(bounds, object(pane.rect)),
      );
      const first: string[] = [];
      const second: string[] = [];

      for (const pane of children) {
        const paneBounds = object(pane.rect);
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

const matchesOwnClose = (
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
    JSON.stringify(frame(before)) === JSON.stringify(frame(after)) &&
    JSON.stringify(expected) === JSON.stringify(actual) &&
    splits(after).length === splits(before).length - 1 &&
    JSON.stringify(topologyAfterRemoval(before, paneId)) ===
      JSON.stringify(topologyAfterRemoval(after))
  );
};

export class ForegroundShares {
  private readonly groups = new Map<string, { tree: Tree; shape: string }>();

  plan(layout: Record<string, unknown>, eligible: TerminalLocation[]): ForegroundPlan | undefined {
    const tabId = text(layout.tab_id);
    const group = this.groups.get(tabId);

    if (!group) {
      return undefined;
    }

    this.groups.delete(tabId);
    const members = leaves(group.tree);

    if (
      group.shape !== layoutShape(layout) ||
      !members.every((paneId) => eligible.some((pane) => pane.paneId === paneId))
    ) {
      return undefined;
    }

    const bounds =
      typeof group.tree === 'string'
        ? rectangle(panes(layout).find((pane) => pane.pane_id === group.tree)?.rect)
        : rectangle(branchSplit(group.tree, layout).rect);

    for (const target of members) {
      const adjustments: Adjustment[] = [];

      if (distribute(group.tree, bounds, target, adjustments)) {
        return { tree: group.tree, target, adjustments };
      }
    }

    return undefined;
  }

  async balance(
    plan: ForegroundPlan,
    layout: Record<string, unknown>,
    eligible: TerminalLocation[],
    call: TerminalCall,
  ): Promise<Record<string, unknown>> {
    let current = layout;

    for (const adjustment of plan.adjustments) {
      const split = branchSplit(adjustment.branch, current);
      const difference = adjustment.ratio - Number(split.ratio);

      // Herdr stores ratios as f32, so comparisons allow its rounding error.
      if (Math.abs(difference) < 0.00001) {
        continue;
      }

      const anchor = edgeLeaf(
        difference > 0 ? adjustment.branch.first : adjustment.branch.second,
        adjustment.branch.direction,
        difference > 0,
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- Recheck identities and geometry before each owned ratio change.
      const live = await listTerminals(call);

      if (
        !leaves(plan.tree).every((paneId) =>
          live.some(
            (pane) =>
              pane.paneId === paneId &&
              eligible.some(
                (owned) => owned.paneId === paneId && owned.terminalId === pane.terminalId,
              ),
          ),
        )
      ) {
        throw new Error('Owned foreground terminal moved; resizing refused.');
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- External changes must not be overwritten by a later step.
      const checked = object(result(await call(['pane', 'layout', '--pane', anchor])).layout);

      if (layoutShape(checked) !== layoutShape(current)) {
        throw new Error('Layout changed during foreground placement; resizing refused.');
      }

      const opposite = adjustment.branch.direction === 'right' ? 'left' : 'up';
      const direction = difference > 0 ? adjustment.branch.direction : opposite;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Resize preserves focus natively and only adjusts the verified adjacent split.
      const response = await call([
        'pane',
        'resize',
        '--pane',
        anchor,
        '--direction',
        direction,
        '--amount',
        String(Math.abs(difference)),
      ]);
      const next = object(object(result(response).resize).layout);
      const beforeSplits = splits(current);
      const afterSplits = splits(next);
      const members = leaves(plan.tree);
      const beforePanes = panes(current);
      const afterPanes = panes(next);
      const samePanes =
        afterPanes.length === beforePanes.length &&
        beforePanes.every((before) =>
          afterPanes.some(
            (after) =>
              after.pane_id === before.pane_id &&
              (members.includes(text(before.pane_id)) ||
                JSON.stringify(after.rect) === JSON.stringify(before.rect)),
          ),
        );

      if (
        !samePanes ||
        JSON.stringify(frame(current)) !== JSON.stringify(frame(next)) ||
        afterSplits.length !== beforeSplits.length ||
        !beforeSplits.every((before) => {
          const after = afterSplits.find((entry) => entry.id === before.id);
          const expected = before.id === split.id ? adjustment.ratio : Number(before.ratio);

          return (
            after &&
            after.direction === before.direction &&
            Math.abs(Number(after.ratio) - expected) < 0.00001
          );
        })
      ) {
        throw new Error(
          'Foreground resize result changed unexpectedly; no retry or layout restore.',
        );
      }

      current = next;
    }

    return current;
  }

  async close(
    location: TerminalLocation,
    call: TerminalCall,
    close: () => Promise<void>,
  ): Promise<void> {
    const group = this.groups.get(location.tabId);
    this.groups.delete(location.tabId);
    let captured:
      | { layout: Record<string, unknown>; terminals: TerminalLocation[]; tree: Tree }
      | undefined;

    try {
      if (group) {
        const layout = object(
          result(await call(['pane', 'layout', '--pane', location.paneId])).layout,
        );
        const terminals = await listTerminals(call);

        if (
          layoutShape(layout) === group.shape &&
          terminals.some(
            (pane) => pane.paneId === location.paneId && pane.terminalId === location.terminalId,
          )
        ) {
          captured = {
            layout,
            terminals: terminals.filter((pane) => pane.tabId === location.tabId),
            tree: group.tree,
          };
        }
      }
    } catch {
      // Layout bookkeeping must not prevent identity-checked worker cleanup.
    }

    await close();

    if (!captured) {
      return;
    }

    const tree = removePane(captured.tree, location.paneId);

    if (tree === undefined) {
      return;
    }

    try {
      const live = await listTerminals(call);
      const survivors = captured.terminals.filter((pane) => pane.paneId !== location.paneId);

      if (
        live.some((pane) => pane.terminalId === location.terminalId) ||
        !survivors.every((pane) =>
          live.some(
            (current) =>
              current.terminalId === pane.terminalId &&
              current.paneId === pane.paneId &&
              current.tabId === pane.tabId,
          ),
        )
      ) {
        return;
      }

      const survivor = leaves(tree)[0];

      if (!survivor) {
        return;
      }

      const layout = object(result(await call(['pane', 'layout', '--pane', survivor])).layout);

      if (matchesOwnClose(captured.layout, layout, location.paneId)) {
        this.groups.set(location.tabId, { tree, shape: layoutShape(layout) });
      }
    } catch {
      // A confirmed close stays confirmed even when its cosmetic snapshot is unavailable.
    }
  }

  async remember(
    before: Record<string, unknown>,
    target: string,
    added: TerminalLocation,
    direction: 'right' | 'down',
    call: TerminalCall,
    tree: Tree | undefined,
    isOwned: () => boolean,
  ): Promise<void> {
    this.groups.delete(added.tabId);

    try {
      const after = object(result(await call(['pane', 'layout', '--pane', added.paneId])).layout);
      const previousPanes = panes(before);
      const nextPanes = panes(after);
      const previousSplits = splits(before);
      const nextSplits = splits(after);
      const created = nextSplits.filter(
        (split) => !previousSplits.some((previous) => splitShape(previous) === splitShape(split)),
      );

      if (
        JSON.stringify(frame(before)) !== JSON.stringify(frame(after)) ||
        nextPanes.length !== previousPanes.length + 1 ||
        created.length !== 1 ||
        nextSplits.length !== previousSplits.length + 1 ||
        created[0]?.direction !== direction ||
        Number(created[0].ratio) !== 0.5 ||
        !previousPanes.every((pane) =>
          nextPanes.some(
            (next) =>
              next.pane_id === pane.pane_id &&
              (pane.pane_id === target || JSON.stringify(next.rect) === JSON.stringify(pane.rect)),
          ),
        ) ||
        !nextPanes.some((pane) => pane.pane_id === added.paneId)
      ) {
        return;
      }

      if (isOwned()) {
        this.groups.set(added.tabId, {
          tree: append(tree ?? target, target, added.paneId, direction),
          shape: layoutShape(after),
        });
      }
    } catch {
      // A lost cosmetic snapshot must not lose the successfully created terminal's ownership or fail worker startup.
    }
  }
}
