import { WorkerPlacement } from '../placement.js';
import type { Visibility } from '../placement.js';
import { requireObject } from '../terminal.js';

interface FixturePane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
}

interface FixtureInput {
  name: string;
  visibility: Visibility;
  cwd: string;
  environment: { TASK: string };
  command: string[];
}

export interface PlacementFixture {
  placement: WorkerPlacement;
  client: (argumentsList: string[]) => Promise<string>;
  input: (visibility: Visibility, name?: string) => FixtureInput;
  calls: string[][];
  panes: FixturePane[];
  titles: Map<string, string>;
  labels: Map<string, string>;
  dimensions: Map<string, { width: number; height: number }>;
  parent: FixturePane;
}

export const placementFixture = (width: number, height: number): PlacementFixture => {
  const parent: FixturePane = {
    pane_id: 'parent',
    terminal_id: 'parent-terminal',
    workspace_id: 'workspace',
    tab_id: 'working',
  };

  const panes = [parent];
  const dimensions = new Map([['parent', { width, height }]]);
  const titles = new Map<string, string>();
  const labels = new Map<string, string>();
  const calls: string[][] = [];
  let created = 0;

  const client = async (argumentsList: string[]) => {
    calls.push(argumentsList);
    const value = (flag: string) => argumentsList[argumentsList.indexOf(flag) + 1];
    const operation = argumentsList[1];

    if (operation === 'current') {
      return JSON.stringify({ result: { pane: parent } });
    }

    if (operation === 'list') {
      return JSON.stringify({ result: { panes } });
    }

    if (operation === 'layout') {
      const tabId = panes.find((pane) => pane.pane_id === value('--pane'))!.tab_id;

      return JSON.stringify({
        result: {
          layout: {
            workspace_id: 'workspace',
            tab_id: tabId,
            zoomed: false,
            area: { x: 0, y: 0, width, height },
            panes: panes
              .filter((pane) => pane.tab_id === tabId)
              .map((pane) => ({ pane_id: pane.pane_id, rect: dimensions.get(pane.pane_id) })),
          },
        },
      });
    }

    if (argumentsList[0] === 'tab' && operation === 'rename') {
      labels.set(argumentsList[2]!, argumentsList.slice(3).join(' '));

      return '{}';
    }

    if (operation === 'rename') {
      const paneId = argumentsList[2] ?? '';
      const label = argumentsList.slice(3).join(' ');
      const pane = panes.find((item) => item.pane_id === paneId);

      if (pane === undefined) {
        throw new Error('pane not found');
      }

      titles.set(paneId, label);

      return JSON.stringify({ result: { pane: { ...pane, title: label } } });
    }

    if (operation === 'close') {
      const target = argumentsList[2]!;
      const index = panes.findIndex((pane) => pane.pane_id === target);

      if (index === -1) {
        throw new Error('pane not found');
      }

      // Close geometry belongs to herdr and is checked in the real-herdr tests.
      panes.splice(index, 1);
      dimensions.delete(target);

      return '{}';
    }

    if (operation === 'get') {
      return JSON.stringify({
        result: { pane: panes.find((pane) => pane.pane_id === argumentsList[2]) },
      });
    }

    if (operation === 'move') {
      const pane = panes.find((item) => item.pane_id === argumentsList[2])!;
      const target = panes.find((item) => item.pane_id === value('--target-pane'))!;
      const bounds = { ...dimensions.get(target.pane_id)! };
      const axis = value('--split') === 'right' ? 'width' : 'height';
      const firstLength = Math.round(bounds[axis] / 2);

      dimensions.set(target.pane_id, { ...bounds, [axis]: firstLength });
      dimensions.set(pane.pane_id, { ...bounds, [axis]: bounds[axis] - firstLength });
      pane.tab_id = target.tab_id;

      return JSON.stringify({ result: { move_result: { pane } } });
    }

    if (operation !== 'apply') {
      throw new Error(`Unexpected operation: ${argumentsList.join(' ')}`);
    }

    created += 1;

    const pane: FixturePane = {
      ...parent,
      pane_id: `worker-${created}`,
      terminal_id: `terminal-${created}`,
      tab_id: `background-${created}`,
    };

    dimensions.set(pane.pane_id, { width, height });
    panes.push(pane);

    labels.set(pane.tab_id, String(requireObject(JSON.parse(argumentsList[2]!)).tab_label));

    return JSON.stringify({ result: { layout: { root: { pane_id: pane.pane_id } } } });
  };

  return {
    placement: new WorkerPlacement(),
    client,
    input: (visibility: Visibility, name = 'worker') => ({
      name,
      visibility,
      cwd: '/work',
      environment: { TASK: 'fixture' },
      command: ['pi'],
    }),
    calls,
    panes,
    titles,
    labels,
    dimensions,
    parent,
  };
};
