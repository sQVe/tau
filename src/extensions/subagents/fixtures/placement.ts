import { WorkerPlacement } from '../placement.js';
import type { Visibility } from '../placement.js';

interface FixturePane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
}

export const placementFixture = (width: number, height: number) => {
  const parent: FixturePane = {
    pane_id: 'parent',
    terminal_id: 'parent-terminal',
    workspace_id: 'workspace',
    tab_id: 'working',
  };

  const panes = [parent];
  const dimensions = new Map([['parent', { width, height }]]);
  const titles = new Map<string, string>();
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

    if (operation !== 'create' && operation !== 'apply') {
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

    return JSON.stringify({
      result:
        operation === 'apply'
          ? { layout: { root: { pane_id: pane.pane_id } } }
          : { root_pane: pane },
    });
  };

  return {
    placement: new WorkerPlacement(),
    client,
    input: (visibility: Visibility) => ({
      visibility,
      cwd: '/work',
      environment: { TASK: 'fixture' },
    }),
    calls,
    panes,
    titles,
    dimensions,
    parent,
  };
};
