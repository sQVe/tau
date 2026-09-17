/* oxlint-disable typescript/no-non-null-assertion, typescript/require-await, eslint/complexity -- Test layout state is constructed by this fake; async client calls need not suspend. */
import { WorkerPlacement } from './placement.js';
import type { Visibility } from './placement.js';

const placementInput = (visibility: Visibility) => ({
  visibility,
  cwd: '/work',
  environment: ['TASK=fixture'],
});

type LayoutNode =
  | string
  | {
      direction: string;
      ratio: number;
      rect: { x: number; y: number; width: number; height: number };
      first: LayoutNode;
      second: LayoutNode;
    };
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

export const placementFixture = (width: number, height: number) => {
  const parent = {
    pane_id: 'parent',
    terminal_id: 'parent-terminal',
    workspace_id: 'workspace',
    tab_id: 'working',
  };
  const panes = [parent];
  const dimensions = new Map([['parent', { width, height }]]);
  const positions = new Map([['parent', { x: 0, y: 0 }]]);
  const trees = new Map<string, LayoutNode>([['working', 'parent']]);
  const update = (
    node: LayoutNode,
    bounds: { x: number; y: number; width: number; height: number },
  ): void => {
    if (typeof node === 'string') {
      dimensions.set(node, { width: bounds.width, height: bounds.height });
      positions.set(node, { x: bounds.x, y: bounds.y });
      return;
    }
    node.rect = bounds;
    const axis = node.direction === 'right' ? 'width' : 'height';
    const position = node.direction === 'right' ? 'x' : 'y';
    // Measured against herdr 0.9.1: the first child rounds, the second takes the rest, no divider cell.
    const firstLength = Math.round(bounds[axis] * node.ratio);
    update(node.first, { ...bounds, [axis]: firstLength });
    update(node.second, {
      ...bounds,
      [axis]: bounds[axis] - firstLength,
      [position]: bounds[position] + firstLength,
    });
  };
  const collapse = (node: LayoutNode, target: string): LayoutNode => {
    if (typeof node === 'string') {
      return node;
    }
    if (node.first === target) {
      update(node.second, node.rect);
      return node.second;
    }
    if (node.second === target) {
      update(node.first, node.rect);
      return node.first;
    }
    node.first = collapse(node.first, target);
    node.second = collapse(node.second, target);

    return node;
  };
  const layout = (tabId: string) => ({
    workspace_id: 'workspace',
    tab_id: tabId,
    zoomed: false,
    area: { x: 0, y: 0, width, height },
    splits: branches(trees.get(tabId)!).map((node, index) => ({
      id: `split-${index}`,
      direction: node.direction,
      ratio: node.ratio,
      rect: node.rect,
    })),
    panes: panes
      .filter((pane) => pane.tab_id === tabId)
      .map((pane) => ({
        pane_id: pane.pane_id,
        rect: { ...positions.get(pane.pane_id), ...dimensions.get(pane.pane_id) },
      })),
  });
  const calls: string[][] = [];
  const placement = new WorkerPlacement();
  let created = 0;
  const client = async (arguments_: string[]) => {
    calls.push(arguments_);
    const value = (flag: string) => arguments_[arguments_.indexOf(flag) + 1];
    if (arguments_[1] === 'current') {
      return JSON.stringify({ result: { pane: parent } });
    }
    if (arguments_[1] === 'list') {
      return JSON.stringify({ result: { panes } });
    }
    if (arguments_[1] === 'layout') {
      const tabId = panes.find((pane) => pane.pane_id === value('--pane'))!.tab_id;

      return JSON.stringify({ result: { layout: layout(tabId) } });
    }
    if (arguments_[1] === 'close') {
      const target = arguments_[2]!;
      const pane = panes.find((entry) => entry.pane_id === target)!;
      trees.set(pane.tab_id, collapse(trees.get(pane.tab_id)!, target));
      panes.splice(panes.indexOf(pane), 1);
      dimensions.delete(target);
      positions.delete(target);

      return '{}';
    }
    if (arguments_[1] === 'resize') {
      const target = value('--pane')!;
      const tabId = panes.find((pane) => pane.pane_id === target)!.tab_id;
      const direction = value('--direction');
      const increasing = direction === 'right' || direction === 'down';
      const axis = direction === 'left' || direction === 'right' ? 'right' : 'down';
      const branch = branches(trees.get(tabId)!).findLast(
        (node) =>
          node.direction === axis && ids(increasing ? node.first : node.second).includes(target),
      )!;
      branch.ratio += Number(value('--amount')) * (increasing ? 1 : -1);
      update(branch, branch.rect);

      return JSON.stringify({ result: { resize: { changed: true, layout: layout(tabId) } } });
    }
    if (arguments_[1] === 'create' || arguments_[1] === 'split') {
      const source = panes.find((pane) => pane.pane_id === value('--pane'));
      const pane = {
        ...parent,
        pane_id: `worker-${++created}`,
        terminal_id: `terminal-${created}`,
        tab_id: source?.tab_id ?? `background-${created}`,
      };
      const bounds = source
        ? { ...positions.get(source.pane_id)!, ...dimensions.get(source.pane_id)! }
        : { x: 0, y: 0, width, height };
      if (source) {
        const branch = {
          direction: value('--direction')!,
          ratio: Number(value('--ratio')),
          rect: bounds,
          first: source.pane_id,
          second: pane.pane_id,
        };
        trees.set(pane.tab_id, replace(trees.get(pane.tab_id)!, source.pane_id, branch));
        update(branch, bounds);
      } else {
        trees.set(pane.tab_id, pane.pane_id);
        update(pane.pane_id, bounds);
      }
      panes.push(pane);

      return JSON.stringify({ result: { [source ? 'pane' : 'root_pane']: pane } });
    }
    throw new Error(`Unexpected operation: ${arguments_.join(' ')}`);
  };
  return { placement, client, input: placementInput, calls, panes, dimensions, parent };
};
