import {
  append,
  contains,
  edgeLeaf,
  frame,
  framesAreEqual,
  isPositiveInteger,
  leaves,
  matchesOwnClose,
  panes,
  removePane,
  splitLengths,
  splitShape,
  splits,
} from './foregroundLayout.js';
import type { Branch, Tree } from './foregroundLayout.js';
import { listTerminals, requireObject, result, text } from './terminal.js';
import type { TerminalCall, TerminalLocation } from './terminal.js';

export interface Rectangle {
  width: number;
  height: number;
}

// Leave room for pane borders and status rows around 80 columns and 20 useful rows.
const minimumPane = { width: 82, height: 24 };

export const rectangle = (value: unknown): Rectangle => {
  const bounds = requireObject(value);

  if (!isPositiveInteger(bounds.width) || !isPositiveInteger(bounds.height)) {
    throw new Error('Invalid herdr pane dimensions.');
  }

  return { width: Number(bounds.width), height: Number(bounds.height) };
};
export const isUseful = (bounds: Rectangle): boolean =>
  bounds.width >= minimumPane.width && bounds.height >= minimumPane.height;

const preferRight = (bounds: Rectangle, down: boolean): boolean =>
  !down || bounds.width / minimumPane.width >= bounds.height / minimumPane.height;

export const splitDirection = (bounds: Rectangle): 'right' | 'down' | undefined => {
  const right = isUseful({ width: splitLengths(bounds.width, 0.5).second, height: bounds.height });
  const down = isUseful({ width: bounds.width, height: splitLengths(bounds.height, 0.5).second });

  if (right && preferRight(bounds, down)) {
    return 'right';
  }

  return down ? 'down' : undefined;
};

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

// Find only the split enclosing the recorded Tau children. Never address a cached split path.
const branchSplit = (tree: Branch, layout: Record<string, unknown>) => {
  const children = leaves(tree).map((paneId) =>
    panes(layout).find((pane) => pane.pane_id === paneId),
  );
  const candidates = splits(layout)
    .filter(
      (split) =>
        split.direction === tree.direction &&
        children.every(
          (child) =>
            child !== undefined && contains(requireObject(split.rect), requireObject(child.rect)),
        ),
    )
    .toSorted(
      (left, right) =>
        Number(requireObject(left.rect).width) * Number(requireObject(left.rect).height) -
        Number(requireObject(right.rect).width) * Number(requireObject(right.rect).height),
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

interface BalanceContext {
  plan: ForegroundPlan;
  eligible: TerminalLocation[];
  call: TerminalCall;
}

interface ResizeSnapshot {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  split: Record<string, unknown>;
  members: string[];
}

const isOwnedTerminal = (
  pane: TerminalLocation,
  paneId: string,
  eligible: TerminalLocation[],
): boolean =>
  pane.paneId === paneId &&
  eligible.some((owned) => owned.paneId === paneId && owned.terminalId === pane.terminalId);

const ownsEveryTerminal = (
  plan: ForegroundPlan,
  live: TerminalLocation[],
  eligible: TerminalLocation[],
): boolean =>
  leaves(plan.tree).every((paneId) => live.some((pane) => isOwnedTerminal(pane, paneId, eligible)));

const ensureOwnedLayout = async (
  context: BalanceContext,
  anchor: string,
  current: Record<string, unknown>,
): Promise<void> => {
  const live = await listTerminals(context.call);

  if (!ownsEveryTerminal(context.plan, live, context.eligible)) {
    throw new Error('Owned foreground terminal moved; resizing refused.');
  }

  const checked = requireObject(
    result(await context.call(['pane', 'layout', '--pane', anchor])).layout,
  );

  if (layoutShape(checked) !== layoutShape(current)) {
    throw new Error('Layout changed during foreground placement; resizing refused.');
  }
};

const resizeDirection = (
  adjustment: Adjustment,
  difference: number,
): 'right' | 'down' | 'left' | 'up' => {
  if (difference > 0) {
    return adjustment.branch.direction;
  }

  return adjustment.branch.direction === 'right' ? 'left' : 'up';
};

const paneRectangleIsAllowed = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  members: string[],
): boolean =>
  members.includes(text(before.pane_id)) ||
  JSON.stringify(after.rect) === JSON.stringify(before.rect);

const layoutPanesMatch = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  members: string[],
): boolean => after.pane_id === before.pane_id && paneRectangleIsAllowed(before, after, members);

const layoutsPreservePanes = (
  beforePanes: Record<string, unknown>[],
  afterPanes: Record<string, unknown>[],
  members: string[],
): boolean =>
  afterPanes.length === beforePanes.length &&
  beforePanes.every((before) =>
    afterPanes.some((after) => layoutPanesMatch(before, after, members)),
  );

const splitAfterResizeMatches = (
  before: Record<string, unknown>,
  afterSplits: Record<string, unknown>[],
  splitId: unknown,
  ratio: number,
): boolean => {
  const after = afterSplits.find((entry) => entry.id === before.id);
  const expected = before.id === splitId ? ratio : Number(before.ratio);

  return (
    Boolean(after) &&
    after?.direction === before.direction &&
    Math.abs(Number(after?.ratio) - expected) < 0.00001
  );
};

const splitsAfterResizeMatch = (
  beforeSplits: Record<string, unknown>[],
  afterSplits: Record<string, unknown>[],
  splitId: unknown,
  ratio: number,
): boolean => {
  if (afterSplits.length !== beforeSplits.length) {
    return false;
  }

  return beforeSplits.every((before) =>
    splitAfterResizeMatches(before, afterSplits, splitId, ratio),
  );
};

const resizeResultIsExpected = (snapshot: ResizeSnapshot, ratio: number): boolean => {
  const frameIsUnchanged = framesAreEqual(snapshot.before, snapshot.after);
  const panesArePreserved = layoutsPreservePanes(
    panes(snapshot.before),
    panes(snapshot.after),
    snapshot.members,
  );
  const splitsAreExpected = splitsAfterResizeMatch(
    splits(snapshot.before),
    splits(snapshot.after),
    snapshot.split.id,
    ratio,
  );

  return frameIsUnchanged && panesArePreserved && splitsAreExpected;
};

const applyAdjustment = async (
  context: BalanceContext,
  adjustment: Adjustment,
  current: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const split = branchSplit(adjustment.branch, current);
  const difference = adjustment.ratio - Number(split.ratio);

  // Herdr stores ratios as f32, so comparisons allow its rounding error.
  if (Math.abs(difference) < 0.00001) {
    return current;
  }

  const anchor = edgeLeaf(
    difference > 0 ? adjustment.branch.first : adjustment.branch.second,
    adjustment.branch.direction,
    difference > 0,
  );

  await ensureOwnedLayout(context, anchor, current);
  const direction = resizeDirection(adjustment, difference);
  const response = await context.call([
    'pane',
    'resize',
    '--pane',
    anchor,
    '--direction',
    direction,
    '--amount',
    String(Math.abs(difference)),
  ]);
  const resized = requireObject(requireObject(result(response).resize).layout);
  const snapshot: ResizeSnapshot = {
    before: current,
    after: resized,
    split,
    members: leaves(context.plan.tree),
  };

  if (!resizeResultIsExpected(snapshot, adjustment.ratio)) {
    throw new Error('Foreground resize result changed unexpectedly; no retry or layout restore.');
  }

  return resized;
};

interface CloseCapture {
  layout: Record<string, unknown>;
  terminals: TerminalLocation[];
  tree: Tree;
}

const captureCloseSnapshot = async (
  group: { tree: Tree; shape: string } | undefined,
  location: TerminalLocation,
  call: TerminalCall,
): Promise<CloseCapture | undefined> => {
  if (!group) {
    return undefined;
  }

  try {
    const layout = requireObject(
      result(await call(['pane', 'layout', '--pane', location.paneId])).layout,
    );
    const terminals = await listTerminals(call);
    const stillOwned = terminals.some(
      (pane) => pane.paneId === location.paneId && pane.terminalId === location.terminalId,
    );

    if (layoutShape(layout) !== group.shape || !stillOwned) {
      return undefined;
    }

    return {
      layout,
      terminals: terminals.filter((pane) => pane.tabId === location.tabId),
      tree: group.tree,
    };
  } catch {
    // Layout bookkeeping must not prevent identity-checked worker cleanup.
    return undefined;
  }
};

const terminalStillExists = (live: TerminalLocation[], location: TerminalLocation): boolean =>
  live.some((pane) => pane.terminalId === location.terminalId);

const survivorsRemainInPlace = (live: TerminalLocation[], survivors: TerminalLocation[]): boolean =>
  survivors.every((pane) =>
    live.some(
      (current) =>
        current.terminalId === pane.terminalId &&
        current.paneId === pane.paneId &&
        current.tabId === pane.tabId,
    ),
  );

const restoreGroupsAfterClose = async (
  shares: Map<string, { tree: Tree; shape: string }>,
  captured: CloseCapture,
  location: TerminalLocation,
  call: TerminalCall,
): Promise<void> => {
  const tree = removePane(captured.tree, location.paneId);

  if (tree === undefined) {
    return;
  }

  try {
    const live = await listTerminals(call);
    const survivors = captured.terminals.filter((pane) => pane.paneId !== location.paneId);

    if (terminalStillExists(live, location) || !survivorsRemainInPlace(live, survivors)) {
      return;
    }

    const survivor = leaves(tree)[0];

    if (survivor == null || survivor === '') {
      return;
    }

    const layout = requireObject(result(await call(['pane', 'layout', '--pane', survivor])).layout);

    if (matchesOwnClose(captured.layout, layout, location.paneId)) {
      shares.set(location.tabId, { tree, shape: layoutShape(layout) });
    }
  } catch {
    // A confirmed close stays confirmed even when its cosmetic snapshot is unavailable.
  }
};

interface RememberRequest {
  before: Record<string, unknown>;
  target: string;
  added: TerminalLocation;
  direction: 'right' | 'down';
  call: TerminalCall;
  tree: Tree | undefined;
  isOwned: () => boolean;
}

const createdSplitIsExpected = (
  created: Record<string, unknown> | undefined,
  direction: 'right' | 'down',
): boolean => created?.direction === direction && Number(created.ratio) === 0.5;

const rememberedPaneRectangleIsAllowed = (
  pane: Record<string, unknown>,
  next: Record<string, unknown>,
  target: string,
): boolean => pane.pane_id === target || JSON.stringify(next.rect) === JSON.stringify(pane.rect);

const rememberedPaneIsPreserved = (
  pane: Record<string, unknown>,
  nextPanes: Record<string, unknown>[],
  target: string,
): boolean =>
  nextPanes.some(
    (next) => next.pane_id === pane.pane_id && rememberedPaneRectangleIsAllowed(pane, next, target),
  );

const previousPanesArePreserved = (
  previousPanes: Record<string, unknown>[],
  nextPanes: Record<string, unknown>[],
  target: string,
): boolean => previousPanes.every((pane) => rememberedPaneIsPreserved(pane, nextPanes, target));

const layoutRemembersPane = (
  request: RememberRequest,
  after: Record<string, unknown>,
  created: Record<string, unknown>[],
): boolean => {
  const previousPanes = panes(request.before);
  const nextPanes = panes(after);
  const previousSplits = splits(request.before);
  const nextSplits = splits(after);
  const layoutShapeIncreased =
    framesAreEqual(request.before, after) &&
    nextPanes.length === previousPanes.length + 1 &&
    nextSplits.length === previousSplits.length + 1;
  const paneSetIsExpected =
    created.length === 1 &&
    createdSplitIsExpected(created[0], request.direction) &&
    previousPanesArePreserved(previousPanes, nextPanes, request.target);

  return (
    layoutShapeIncreased &&
    paneSetIsExpected &&
    nextPanes.some((pane) => pane.pane_id === request.added.paneId)
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
    const context: BalanceContext = { plan, eligible, call };
    let current = layout;

    for (const adjustment of plan.adjustments) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Recheck identities and geometry before each owned ratio change.
      current = await applyAdjustment(context, adjustment, current);
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
    const captured = await captureCloseSnapshot(group, location, call);

    await close();

    if (!captured) {
      return;
    }

    await restoreGroupsAfterClose(this.groups, captured, location, call);
  }

  async remember(request: RememberRequest): Promise<void> {
    this.groups.delete(request.added.tabId);

    try {
      const after = requireObject(
        result(await request.call(['pane', 'layout', '--pane', request.added.paneId])).layout,
      );
      const previousSplits = splits(request.before);
      const nextSplits = splits(after);
      const created = nextSplits.filter(
        (split) => !previousSplits.some((previous) => splitShape(previous) === splitShape(split)),
      );

      if (layoutRemembersPane(request, after, created) && request.isOwned()) {
        this.groups.set(request.added.tabId, {
          tree: append(
            request.tree ?? request.target,
            request.target,
            request.added.paneId,
            request.direction,
          ),
          shape: layoutShape(after),
        });
      }
    } catch {
      // A lost cosmetic snapshot must not lose the successfully created terminal's ownership or fail worker startup.
    }
  }
}
