import { expect, it } from 'vitest';

import { minimumPane } from '../src/extensions/subagents/foreground.js';
import { WorkerPlacement } from '../src/extensions/subagents/placement.js';
import {
  listTerminals,
  object,
  resolveTerminal,
  result,
  terminalLocation,
} from '../src/extensions/subagents/terminal.js';
import { isolatedHerdr } from './isolatedHerdr.js';
import { toolAvailable } from './toolAvailable.js';

const hasHerdr = toolAvailable('herdr');

it.runIf(hasHerdr).each([
  [340, 100, 2],
  [340, 100, 4],
  [250, 30, 2],
])(
  'shares real foreground space at %s x %s with %s workers using native resize',
  async (width, height, count) => {
    const { root, client } = await isolatedHerdr(
      `[server]\nheadless_cols = ${width}\nheadless_rows = ${height}\n[ui]\nsidebar_start_collapsed = true\nsidebar_collapsed_mode = "hidden"\nhide_tab_bar_when_single_tab = true\n`,
    );
    const parent = terminalLocation(
      result(await client(['workspace', 'create', '--cwd', root, '--focus'])).root_pane,
    );
    const placement = new WorkerPlacement();
    const workers = await Promise.all(
      Array.from({ length: count }, () =>
        placement.place(
          { parentPane: parent.paneId, visibility: 'foreground', cwd: root, environment: [] },
          client,
        ),
      ),
    );
    const layout = object(result(await client(['pane', 'layout', '--pane', parent.paneId])).layout);
    const entries = (layout.panes as Record<string, unknown>[]).map((pane) => object(pane.rect));
    const areas = entries.map((bounds) => Number(bounds.width) * Number(bounds.height));

    expect(layout.area).toMatchObject({ width, height });
    expect(workers.every((worker) => worker.tabId === parent.tabId)).toBe(true);
    expect(entries).toHaveLength(count + 1);
    expect(Math.max(...areas) / Math.min(...areas)).toBeLessThan(1.1);
    expect(layout.focused_pane_id).toBe(parent.paneId);

    for (const bounds of entries) {
      expect(Number(bounds.width)).toBeGreaterThanOrEqual(minimumPane.width);
      expect(Number(bounds.height)).toBeGreaterThanOrEqual(minimumPane.height);
    }
  },
  20_000,
);

it.runIf(hasHerdr).each([0, 1])(
  'keeps native foreground shares after owned worker %s closes and is replaced',
  async (index) => {
    const { root, client } = await isolatedHerdr(
      '[server]\nheadless_cols = 340\nheadless_rows = 100\n[ui]\nsidebar_start_collapsed = true\nsidebar_collapsed_mode = "hidden"\nhide_tab_bar_when_single_tab = true\n',
    );
    const parent = terminalLocation(
      result(await client(['workspace', 'create', '--cwd', root, '--focus'])).root_pane,
    );
    const placement = new WorkerPlacement();
    const input = {
      parentPane: parent.paneId,
      visibility: 'foreground' as const,
      cwd: root,
      environment: [],
    };
    const workers = await Promise.all([
      placement.place(input, client),
      placement.place(input, client),
    ]);
    const closing = workers[index]!;
    placement.release(closing.terminalId);
    await placement.close(closing, client, async () => {
      await client(['pane', 'close', closing.paneId]);
    });
    const replacement = await placement.place(input, client);
    const layout = object(result(await client(['pane', 'layout', '--pane', parent.paneId])).layout);
    const entries = (layout.panes as Record<string, unknown>[]).map((pane) => object(pane.rect));
    const areas = entries.map((bounds) => Number(bounds.width) * Number(bounds.height));
    const terminals = await listTerminals(client);

    expect(replacement.tabId).toBe(parent.tabId);
    expect(entries).toHaveLength(3);
    expect(Math.max(...areas) / Math.min(...areas)).toBeLessThan(1.1);
    expect(layout.focused_pane_id).toBe(parent.paneId);
    expect(terminals.some((pane) => pane.terminalId === closing.terminalId)).toBe(false);
    expect(terminals.some((pane) => pane.terminalId === workers[1 - index]!.terminalId)).toBe(true);
  },
  20_000,
);

it.runIf(hasHerdr)(
  'preserves a manual Tau ratio and unrelated topology during later foreground placement',
  async () => {
    const { root, client } = await isolatedHerdr(
      '[server]\nheadless_cols = 600\nheadless_rows = 120\n[ui]\nsidebar_start_collapsed = true\nsidebar_collapsed_mode = "hidden"\nhide_tab_bar_when_single_tab = true\n',
    );
    const parent = terminalLocation(
      result(await client(['workspace', 'create', '--cwd', root, '--focus'])).root_pane,
    );
    const unrelated = terminalLocation(
      result(
        await client([
          'pane',
          'split',
          '--pane',
          parent.paneId,
          '--direction',
          'right',
          '--ratio',
          '0.6',
          '--cwd',
          root,
          '--no-focus',
        ]),
      ).pane,
    );
    const placement = new WorkerPlacement();
    const input = {
      parentPane: parent.paneId,
      visibility: 'foreground' as const,
      cwd: root,
      environment: [],
    };
    await placement.place(input, client);
    await client([
      'pane',
      'resize',
      '--pane',
      parent.paneId,
      '--direction',
      'down',
      '--amount',
      '0.1',
    ]);
    await client(['pane', 'focus', '--pane', parent.paneId, '--direction', 'right']);
    const before = object(result(await client(['pane', 'layout', '--pane', parent.paneId])).layout);
    await placement.place(input, client);
    await placement.place(input, client);
    const after = object(result(await client(['pane', 'layout', '--pane', parent.paneId])).layout);
    const beforeSplits = before.splits as Record<string, unknown>[];
    const afterSplits = after.splits as Record<string, unknown>[];
    const beforePanes = before.panes as Record<string, unknown>[];
    const afterPanes = after.panes as Record<string, unknown>[];

    for (const split of beforeSplits) {
      expect(afterSplits).toContainEqual(
        expect.objectContaining({
          direction: split.direction,
          ratio: split.ratio,
          rect: split.rect,
        }),
      );
    }

    expect(afterPanes.find((pane) => pane.pane_id === unrelated.paneId)).toEqual(
      beforePanes.find((pane) => pane.pane_id === unrelated.paneId),
    );
    expect(before.focused_pane_id).toBe(unrelated.paneId);
    expect(after.focused_pane_id).toBe(unrelated.paneId);
  },
  20_000,
);

it.runIf(hasHerdr)(
  'places ten inspectable dummy terminals without changing manual layout or focus in isolated herdr',
  async () => {
    const { root, client } = await isolatedHerdr();
    const parent = terminalLocation(
      result(await client(['workspace', 'create', '--cwd', root, '--focus'])).root_pane,
    );
    const unrelated = terminalLocation(
      result(
        await client([
          'pane',
          'split',
          '--pane',
          parent.paneId,
          '--direction',
          'right',
          '--ratio',
          '0.3',
          '--cwd',
          root,
          '--no-focus',
        ]),
      ).pane,
    );
    await client([
      'pane',
      'resize',
      '--pane',
      parent.paneId,
      '--direction',
      'right',
      '--amount',
      '0.05',
    ]);
    const before = object(result(await client(['pane', 'layout', '--pane', parent.paneId])).layout);
    const focusBefore = object(result(await client(['api', 'snapshot'])).snapshot);
    const placement = new WorkerPlacement();
    const workers = await Promise.all(
      Array.from({ length: 10 }, () =>
        placement.place(
          {
            parentPane: parent.paneId,
            visibility: 'background',
            cwd: root,
            environment: [],
          },
          client,
        ),
      ),
    );
    const after = object(result(await client(['pane', 'layout', '--pane', parent.paneId])).layout);
    const focusAfter = object(result(await client(['api', 'snapshot'])).snapshot);

    expect(after).toEqual(before);
    expect(workers).toHaveLength(10);
    expect(new Set(workers.map((worker) => worker.terminalId)).size).toBe(10);
    expect(focusAfter.focused_pane_id).toBe(focusBefore.focused_pane_id);
    expect(focusAfter.focused_tab_id).toBe(focusBefore.focused_tab_id);
    expect(focusAfter.focused_workspace_id).toBe(focusBefore.focused_workspace_id);
    expect(await resolveTerminal(unrelated.terminalId, client)).toEqual(unrelated);

    for (const worker of workers) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Check real geometry of every created terminal, not a fixed tab capacity.
      const layout = object(
        result(await client(['pane', 'layout', '--pane', worker.paneId])).layout,
      );
      const panes = layout.panes as { pane_id: string; rect: { width: number; height: number } }[];
      const bounds = panes.find((pane) => pane.pane_id === worker.paneId)!.rect;

      expect(bounds.width).toBeGreaterThanOrEqual(minimumPane.width);
      expect(bounds.height).toBeGreaterThanOrEqual(minimumPane.height);
    }

    const moved = object(
      result(await client(['pane', 'move', workers[0]!.paneId, '--new-workspace', '--no-focus']))
        .move_result,
    );
    const movedPane = terminalLocation(moved.pane);
    const resolved = await resolveTerminal(workers[0]!.terminalId, client);

    expect(resolved).toEqual(movedPane);
    expect(resolved.paneId).not.toBe(workers[0]!.paneId);
    await client(['pane', 'close', resolved.paneId]);
    const remaining = await listTerminals(client);
    expect(remaining.some((pane) => pane.terminalId === resolved.terminalId)).toBe(false);
    expect(remaining.some((pane) => pane.terminalId === unrelated.terminalId)).toBe(true);
    expect(
      object(result(await client(['pane', 'layout', '--pane', parent.paneId])).layout),
    ).toEqual(before);
  },
  20_000,
);
