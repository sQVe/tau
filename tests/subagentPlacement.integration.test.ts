import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, it } from 'vitest';

import { isolatedHerdr } from '../src/extensions/subagents/fixtures/isolatedHerdr.js';
import { toolAvailable } from '../src/extensions/subagents/fixtures/toolAvailable.js';
import { WorkerPlacement } from '../src/extensions/subagents/placement.js';
import {
  listTerminals,
  requireObject,
  resolveTerminal,
  result,
  terminalLocation,
} from '../src/extensions/subagents/terminal.js';

const minimumPane = { width: 82, height: 24 };

const hasHerdr = toolAvailable('herdr');

it.runIf(hasHerdr).each([
  [340, 100, 3, 1],
  [250, 30, 2, 1],
])(
  'keeps useful real panes at %s x %s with %s workers and %s foreground workers',
  async (width, height, count, foregroundCount) => {
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
          {
            name: 'worker',
            parentPane: parent.paneId,
            visibility: 'foreground',
            cwd: root,
            environment: {},
            command: ['/bin/sh', '-c', 'while [ ! -e "$EXIT_SIGNAL" ]; do sleep 0.05; done'],
          },
          client,
        ),
      ),
    );

    const layout = requireObject(
      result(await client(['pane', 'layout', '--pane', parent.paneId])).layout,
    );

    const entries = (layout.panes as Record<string, unknown>[]).map((pane) =>
      requireObject(pane.rect),
    );

    expect(layout.area).toMatchObject({ width, height });
    expect(workers.filter((worker) => worker.tabId === parent.tabId)).toHaveLength(foregroundCount);
    expect(entries).toHaveLength(foregroundCount + 1);
    expect(layout.focused_pane_id).toBe(parent.paneId);

    for (const bounds of entries) {
      expect(Number(bounds.width)).toBeGreaterThanOrEqual(minimumPane.width);
      expect(Number(bounds.height)).toBeGreaterThanOrEqual(minimumPane.height);
    }
  },
  20_000,
);

it.runIf(hasHerdr)(
  'runs a command worker as its own pane process beside the parent until it exits',
  async () => {
    const { root, client } = await isolatedHerdr(
      '[server]\nheadless_cols = 340\nheadless_rows = 100\n[ui]\nsidebar_start_collapsed = true\nsidebar_collapsed_mode = "hidden"\n',
    );

    const parent = terminalLocation(
      result(await client(['workspace', 'create', '--cwd', root, '--focus'])).root_pane,
    );

    const exitSignal = join(root, 'exit');

    const worker = await new WorkerPlacement().place(
      {
        parentPane: parent.paneId,
        name: 'worker',
        visibility: 'foreground',
        cwd: root,
        environment: { EXIT_SIGNAL: exitSignal },
        command: ['/bin/sh', '-c', 'while [ ! -e "$EXIT_SIGNAL" ]; do sleep 0.05; done'],
      },
      client,
    );

    const information = requireObject(
      result(await client(['pane', 'process-info', '--pane', worker.paneId])).process_info,
    );

    const layout = requireObject(
      result(await client(['pane', 'layout', '--pane', parent.paneId])).layout,
    );

    const processes = information.foreground_processes as Record<string, unknown>[];

    const tabs = requireObject(
      result(await client(['tab', 'list', '--workspace', parent.workspaceId])),
    ).tabs as unknown[];

    expect(worker).toMatchObject({ tabId: parent.tabId, visibility: 'foreground' });

    expect(processes.find((entry) => entry.pid === information.shell_pid)?.argv).toEqual([
      '/bin/sh',
      '-c',
      'while [ ! -e "$EXIT_SIGNAL" ]; do sleep 0.05; done',
    ]);

    expect(layout.focused_pane_id).toBe(parent.paneId);
    expect(tabs).toHaveLength(1);

    writeFileSync(exitSignal, '');
    const deadline = performance.now() + 5000;

    while ((await listTerminals(client)).some((pane) => pane.terminalId === worker.terminalId)) {
      expect(performance.now()).toBeLessThan(deadline);
      await delay(25);
    }
  },
  20_000,
);

it.runIf(hasHerdr)(
  'shows a new foreground worker after herdr closes the visible one',
  async () => {
    const { root, client } = await isolatedHerdr(
      '[server]\nheadless_cols = 340\nheadless_rows = 100\n[ui]\nsidebar_start_collapsed = true\nsidebar_collapsed_mode = "hidden"\nhide_tab_bar_when_single_tab = true\n',
    );

    const parent = terminalLocation(
      result(await client(['workspace', 'create', '--cwd', root, '--focus'])).root_pane,
    );

    const placement = new WorkerPlacement();

    const input = {
      parentPane: parent.paneId,
      name: 'worker',
      visibility: 'foreground' as const,
      cwd: root,
      environment: {},
      command: ['/bin/sh', '-c', 'while [ ! -e "$EXIT_SIGNAL" ]; do sleep 0.05; done'],
    };

    const visible = await placement.place(input, client);
    const hidden = await placement.place(input, client);
    placement.release(visible.terminalId);

    await placement.close(async () => {
      await client(['pane', 'close', visible.paneId]);
    });

    const replacement = await placement.place(input, client);

    const layout = requireObject(
      result(await client(['pane', 'layout', '--pane', parent.paneId])).layout,
    );

    const terminals = await listTerminals(client);

    expect(hidden.tabId).not.toBe(parent.tabId);
    expect(replacement.tabId).toBe(parent.tabId);
    expect(layout.panes).toHaveLength(2);
    expect(layout.focused_pane_id).toBe(parent.paneId);
    expect(terminals.some((pane) => pane.terminalId === visible.terminalId)).toBe(false);
    expect(terminals.some((pane) => pane.terminalId === hidden.terminalId)).toBe(true);
  },
  20_000,
);

it.runIf(hasHerdr)(
  'preserves a manual Tau ratio and unrelated topology during later placement',
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
      name: 'worker',
      visibility: 'foreground' as const,
      cwd: root,
      environment: {},
      command: ['/bin/sh', '-c', 'while [ ! -e "$EXIT_SIGNAL" ]; do sleep 0.05; done'],
    };

    const worker = await placement.place(input, client);

    await client([
      'pane',
      'resize',
      '--pane',
      parent.paneId,
      '--direction',
      'right',
      '--amount',
      '0.1',
    ]);

    await client(['pane', 'focus', '--pane', worker.paneId, '--direction', 'right']);

    const before = requireObject(
      result(await client(['pane', 'layout', '--pane', parent.paneId])).layout,
    );

    await placement.place(input, client);
    await placement.place(input, client);

    const after = requireObject(
      result(await client(['pane', 'layout', '--pane', parent.paneId])).layout,
    );

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

    const before = requireObject(
      result(await client(['pane', 'layout', '--pane', parent.paneId])).layout,
    );

    const focusBefore = requireObject(result(await client(['api', 'snapshot'])).snapshot);
    const placement = new WorkerPlacement();

    const workers = await Promise.all(
      Array.from({ length: 10 }, () =>
        placement.place(
          {
            parentPane: parent.paneId,
            name: 'worker',
            visibility: 'background',
            cwd: root,
            environment: {},
            command: ['/bin/sh', '-c', 'while [ ! -e "$EXIT_SIGNAL" ]; do sleep 0.05; done'],
          },
          client,
        ),
      ),
    );

    const after = requireObject(
      result(await client(['pane', 'layout', '--pane', parent.paneId])).layout,
    );

    const focusAfter = requireObject(result(await client(['api', 'snapshot'])).snapshot);

    expect(after).toEqual(before);
    expect(workers).toHaveLength(10);
    expect(new Set(workers.map((worker) => worker.terminalId)).size).toBe(10);
    expect(focusAfter.focused_pane_id).toBe(focusBefore.focused_pane_id);
    expect(focusAfter.focused_tab_id).toBe(focusBefore.focused_tab_id);
    expect(focusAfter.focused_workspace_id).toBe(focusBefore.focused_workspace_id);
    expect(await resolveTerminal(unrelated.terminalId, client)).toEqual(unrelated);

    for (const worker of workers) {
      const layout = requireObject(
        result(await client(['pane', 'layout', '--pane', worker.paneId])).layout,
      );

      const panes = layout.panes as { pane_id: string; rect: { width: number; height: number } }[];
      const bounds = panes.find((pane) => pane.pane_id === worker.paneId)!.rect;

      expect(bounds.width).toBeGreaterThanOrEqual(minimumPane.width);
      expect(bounds.height).toBeGreaterThanOrEqual(minimumPane.height);
    }

    const moved = requireObject(
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
      requireObject(result(await client(['pane', 'layout', '--pane', parent.paneId])).layout),
    ).toEqual(before);
  },
  20_000,
);
