import { WorkerPlacement } from '../placement.js';
import type { Visibility } from '../placement.js';

const placementInput = (visibility: Visibility) => ({
  visibility,
  cwd: '/work',
  environment: ['TASK=fixture'],
});

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FixturePane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
}

type LayoutNode =
  | string
  | {
      direction: string;
      ratio: number;
      rect: Bounds;
      first: LayoutNode;
      second: LayoutNode;
    };

interface FixtureState {
  width: number;
  height: number;
  parent: FixturePane;
  panes: FixturePane[];
  dimensions: Map<string, { width: number; height: number }>;
  positions: Map<string, { x: number; y: number }>;
  trees: Map<string, LayoutNode>;
  titles: Map<string, string>;
  calls: string[][];
  created: number;
}

const ids = (node: LayoutNode): string[] =>
  typeof node === 'string' ? [node] : [...ids(node.first), ...ids(node.second)];

const replace = (node: LayoutNode, target: string, replacement: LayoutNode): LayoutNode => {
  if (typeof node === 'string') {
    return node === target ? replacement : node;
  }

  node.first = replace(node.first, target, replacement);
  node.second = replace(node.second, target, replacement);

  return node;
};

const branches = (node: LayoutNode): Exclude<LayoutNode, string>[] =>
  typeof node === 'string' ? [] : [node, ...branches(node.first), ...branches(node.second)];

const updateLayout = (state: FixtureState, node: LayoutNode, bounds: Bounds): void => {
  if (typeof node === 'string') {
    state.dimensions.set(node, { width: bounds.width, height: bounds.height });
    state.positions.set(node, { x: bounds.x, y: bounds.y });

    return;
  }

  node.rect = bounds;
  const axis = node.direction === 'right' ? 'width' : 'height';
  const position = node.direction === 'right' ? 'x' : 'y';
  // Measured against herdr 0.9.1: the first child rounds, the second takes the rest, no divider cell.
  const firstLength = Math.round(bounds[axis] * node.ratio);
  updateLayout(state, node.first, { ...bounds, [axis]: firstLength });

  updateLayout(state, node.second, {
    ...bounds,
    [axis]: bounds[axis] - firstLength,
    [position]: bounds[position] + firstLength,
  });
};

const collapseLayout = (state: FixtureState, node: LayoutNode, target: string): LayoutNode => {
  if (typeof node === 'string') {
    return node;
  }

  if (node.first === target) {
    updateLayout(state, node.second, node.rect);

    return node.second;
  }

  if (node.second === target) {
    updateLayout(state, node.first, node.rect);

    return node.first;
  }

  node.first = collapseLayout(state, node.first, target);
  node.second = collapseLayout(state, node.second, target);

  return node;
};

const buildLayout = (state: FixtureState, tabId: string) => ({
  workspace_id: 'workspace',
  tab_id: tabId,
  zoomed: false,
  area: { x: 0, y: 0, width: state.width, height: state.height },
  splits: branches(state.trees.get(tabId)!).map((node, index) => ({
    id: `split-${index}`,
    direction: node.direction,
    ratio: node.ratio,
    rect: node.rect,
  })),
  panes: state.panes
    .filter((pane) => pane.tab_id === tabId)
    .map((pane) => ({
      pane_id: pane.pane_id,
      rect: { ...state.positions.get(pane.pane_id), ...state.dimensions.get(pane.pane_id) },
    })),
});

const handleLayout = (state: FixtureState, value: (flag: string) => string | undefined) => {
  const tabId = state.panes.find((pane) => pane.pane_id === value('--pane'))!.tab_id;

  return JSON.stringify({ result: { layout: buildLayout(state, tabId) } });
};

const handleClose = (state: FixtureState, argumentsList: string[]) => {
  const target = argumentsList[2]!;
  const pane = state.panes.find((entry) => entry.pane_id === target)!;

  state.trees.set(pane.tab_id, collapseLayout(state, state.trees.get(pane.tab_id)!, target));
  state.panes.splice(state.panes.indexOf(pane), 1);
  state.dimensions.delete(target);
  state.positions.delete(target);

  return '{}';
};

const handleResize = (state: FixtureState, value: (flag: string) => string | undefined) => {
  const target = value('--pane')!;
  const tabId = state.panes.find((pane) => pane.pane_id === target)!.tab_id;
  const direction = value('--direction');
  const increasing = direction === 'right' || direction === 'down';
  const axis = direction === 'left' || direction === 'right' ? 'right' : 'down';

  const branch = branches(state.trees.get(tabId)!).findLast(
    (node) =>
      node.direction === axis && ids(increasing ? node.first : node.second).includes(target),
  )!;

  branch.ratio += Number(value('--amount')) * (increasing ? 1 : -1);
  updateLayout(state, branch, branch.rect);

  return JSON.stringify({
    result: { resize: { changed: true, layout: buildLayout(state, tabId) } },
  });
};

const handleCreate = (state: FixtureState, value: (flag: string) => string | undefined) => {
  const source = state.panes.find((pane) => pane.pane_id === value('--pane'));

  const pane: FixturePane = {
    ...state.parent,
    pane_id: `worker-${state.created + 1}`,
    terminal_id: `terminal-${state.created + 1}`,
    tab_id: source?.tab_id ?? `background-${state.created + 1}`,
  };

  state.created += 1;

  const bounds = source
    ? { ...state.positions.get(source.pane_id)!, ...state.dimensions.get(source.pane_id)! }
    : { x: 0, y: 0, width: state.width, height: state.height };

  if (source) {
    const branch = {
      direction: value('--direction')!,
      ratio: Number(value('--ratio')),
      rect: bounds,
      first: source.pane_id,
      second: pane.pane_id,
    };

    state.trees.set(pane.tab_id, replace(state.trees.get(pane.tab_id)!, source.pane_id, branch));
    updateLayout(state, branch, bounds);
  } else {
    state.trees.set(pane.tab_id, pane.pane_id);
    updateLayout(state, pane.pane_id, bounds);
  }

  state.panes.push(pane);

  return JSON.stringify({ result: { [source ? 'pane' : 'root_pane']: pane } });
};

const respond = async (state: FixtureState, argumentsList: string[]) => {
  state.calls.push(argumentsList);
  const value = (flag: string) => argumentsList[argumentsList.indexOf(flag) + 1];
  const operation = argumentsList[1];

  if (operation === 'current') {
    return JSON.stringify({ result: { pane: state.parent } });
  }

  if (operation === 'list') {
    return JSON.stringify({ result: { panes: state.panes } });
  }

  if (operation === 'layout') {
    return handleLayout(state, value);
  }

  if (operation === 'rename') {
    const paneId = argumentsList[2] ?? '';
    const label = argumentsList.slice(3).join(' ');
    const pane = state.panes.find((item) => item.pane_id === paneId);

    if (pane === undefined) {
      throw new Error('pane not found');
    }

    state.titles.set(paneId, label);

    return JSON.stringify({ result: { pane: { ...pane, title: label } } });
  }

  if (operation === 'close') {
    return handleClose(state, argumentsList);
  }

  if (operation === 'resize') {
    return handleResize(state, value);
  }

  if (operation === 'create' || operation === 'split') {
    return handleCreate(state, value);
  }

  throw new Error(`Unexpected operation: ${argumentsList.join(' ')}`);
};

export const placementFixture = (width: number, height: number) => {
  const parent: FixturePane = {
    pane_id: 'parent',
    terminal_id: 'parent-terminal',
    workspace_id: 'workspace',
    tab_id: 'working',
  };

  const state: FixtureState = {
    width,
    height,
    parent,
    panes: [parent],
    dimensions: new Map([['parent', { width, height }]]),
    positions: new Map([['parent', { x: 0, y: 0 }]]),
    trees: new Map([['working', 'parent']]),
    titles: new Map(),
    calls: [],
    created: 0,
  };

  return {
    placement: new WorkerPlacement(),
    client: (argumentsList: string[]) => respond(state, argumentsList),
    input: placementInput,
    calls: state.calls,
    panes: state.panes,
    titles: state.titles,
    dimensions: state.dimensions,
    parent: state.parent,
  };
};
