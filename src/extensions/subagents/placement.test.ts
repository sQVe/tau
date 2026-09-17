import { expect, it, vi, onTestFinished } from 'vitest';

import { minimumPane, splitDirection } from './foreground.js';
import { placementFixture as fixture } from './placementFixture.js';

it.each([
  [100, 100, 'down'],
  [400, 30, 'right'],
  [400, 100, 'right'],
  [164, 48, undefined],
  [165, 24, 'right'],
  [82, 49, 'down'],
  [81, 100, undefined],
  [400, 23, undefined],
] as const)('chooses useful splits for %s columns and %s rows', (width, height, direction) => {
  expect(splitDirection({ width, height })).toBe(direction);
});

it.each([
  [340, 100, [10]],
  [340, 50, [8, 2]],
  [170, 50, [4, 4, 2]],
  [100, 50, [2, 2, 2, 2, 2]],
] as const)(
  'groups ten background workers by dimensions %s x %s',
  async (width, height, expected) => {
    const { placement, client, input, panes, dimensions, calls } = fixture(width, height);

    await Promise.all(
      Array.from({ length: 10 }, () => placement.place(input('background'), client)),
    );
    const counts = new Map<string, number>();
    for (const pane of panes.slice(1)) {
      counts.set(pane.tab_id, (counts.get(pane.tab_id) ?? 0) + 1);
      const bounds = dimensions.get(pane.pane_id)!;
      expect(bounds.width).toBeGreaterThanOrEqual(minimumPane.width);
      expect(bounds.height).toBeGreaterThanOrEqual(minimumPane.height);
    }
    expect([...counts.values()]).toEqual(expected);
    expect(dimensions.get('parent')).toEqual({ width, height });
    expect(
      calls
        .filter((call) => ['split', 'create'].includes(call[1]!))
        .every((call) => call.includes('--no-focus')),
    ).toBe(true);
    expect(calls.some((call) => ['resize', 'apply', 'focus', 'move'].includes(call[1]!))).toBe(
      false,
    );
  },
);

it.each([2, 4])('shares approximately equal foreground area with %s workers', async (workers) => {
  const { placement, client, input, panes, dimensions } = fixture(340, 100);

  await Promise.all(
    Array.from({ length: workers }, () => placement.place(input('foreground'), client)),
  );
  const areas = [...dimensions.values()].map((bounds) => bounds.width * bounds.height);
  expect(panes.every((pane) => pane.tab_id === 'working')).toBe(true);
  expect(Math.max(...areas) / Math.min(...areas)).toBeLessThan(1.1);
});

it('fits two foreground workers beside the parent in 250 columns and 30 rows', async () => {
  const { placement, client, input, panes, dimensions } = fixture(250, 30);

  await Promise.all(Array.from({ length: 2 }, () => placement.place(input('foreground'), client)));
  expect(panes.map((pane) => pane.tab_id)).toEqual(['working', 'working', 'working']);
  for (const bounds of dimensions.values()) {
    expect(bounds.width).toBeGreaterThanOrEqual(82);
    expect(bounds.height).toBe(30);
  }
});

it('shares foreground space with the parent instead of repeatedly halving it', async () => {
  const { placement, client, input, panes, dimensions } = fixture(340, 100);

  await Promise.all(Array.from({ length: 3 }, () => placement.place(input('foreground'), client)));
  expect(panes.every((pane) => pane.tab_id === 'working')).toBe(true);
  const areas = [...dimensions.values()].map((bounds) => bounds.width * bounds.height);
  expect(Math.max(...areas) / Math.min(...areas)).toBeLessThan(1.05);
});

it('keeps equal foreground shares after confirmed owned cleanup and replacement', async () => {
  const { placement, client, input, panes, dimensions } = fixture(340, 100);
  const first = await placement.place(input('foreground'), client);
  await placement.place(input('foreground'), client);
  placement.release(first.terminalId);
  await placement.close(first, client, async () => {
    await client(['pane', 'close', first.paneId]);
  });
  await placement.place(input('foreground'), client);

  expect(panes.map((pane) => pane.tab_id)).toEqual(['working', 'working', 'working']);
  const areas = [...dimensions.values()].map((bounds) => bounds.width * bounds.height);
  expect(Math.max(...areas) / Math.min(...areas)).toBeLessThan(1.1);
});

it.each([
  'external close',
  'uncertain close',
  'manual resize before close',
  'manual resize after close',
] as const)('does not infer surviving split ownership after %s', async (scenario) => {
  const { placement, client, input, calls } = fixture(340, 100);
  const first = await placement.place(input('foreground'), client);
  await placement.place(input('foreground'), client);
  placement.release(first.terminalId);
  const close = async () => {
    await client(['pane', 'close', first.paneId]);
    if (scenario === 'uncertain close') {
      throw new Error('Closure delivery uncertain');
    }
    if (scenario === 'manual resize after close') {
      await client([
        'pane',
        'resize',
        '--pane',
        'parent',
        '--direction',
        'right',
        '--amount',
        '0.1',
      ]);
    }
  };
  if (scenario === 'manual resize before close') {
    await client([
      'pane',
      'resize',
      '--pane',
      first.paneId,
      '--direction',
      'up',
      '--amount',
      '0.1',
    ]);
  }
  let failure: unknown;
  try {
    if (scenario === 'external close') {
      await close();
    } else {
      await placement.close(first, client, close);
    }
  } catch (error) {
    failure = error;
  }
  const previousCalls = calls.length;
  await placement.place(input('foreground'), client);

  expect(failure instanceof Error).toBe(scenario === 'uncertain close');
  expect(calls.slice(previousCalls).some((call) => call[1] === 'resize')).toBe(false);
});

it('releases a confirmed terminal after abort even if its cosmetic snapshot completes late', async () => {
  const { placement, client, input, calls, dimensions } = fixture(340, 100);
  const abort = new AbortController();
  const snapshot = Promise.withResolvers<undefined>();
  const snapshotReturned = Promise.withResolvers<undefined>();
  let created: { paneId: string; terminalId: string } | undefined;
  const delayed = async (arguments_: string[]) => {
    if (created && arguments_[1] === 'layout') {
      abort.abort();
      await snapshot.promise;
      snapshotReturned.resolve(undefined);
    }

    return client(arguments_);
  };
  await expect(
    placement.place(
      {
        ...input('foreground'),
        onCreated: (location) => {
          created = location;
        },
      },
      delayed,
      abort.signal,
    ),
  ).rejects.toThrow(/cancelled/);
  snapshot.resolve(undefined);
  await snapshotReturned.promise;
  dimensions.set('parent', { width: 100, height: 30 });
  const previousCalls = calls.length;
  const replacement = await placement.place(input('foreground'), client);

  expect(created).toBeDefined();
  expect(replacement.tabId).not.toBe('working');
  expect(calls.slice(previousCalls).some((call) => ['resize', 'split'].includes(call[1]!))).toBe(
    false,
  );
});

it('groups foreground overflow by useful space instead of creating a tab per worker', async () => {
  const { placement, client, input, dimensions } = fixture(100, 50);
  dimensions.set('parent', { width: 100, height: 30 });
  const first = await placement.place(input('foreground'), client);
  const second = await placement.place(input('foreground'), client);

  expect(second.tabId).toBe(first.tabId);
  expect(dimensions.get('parent')).toEqual({ width: 100, height: 30 });
});

it('uses a background tab when the parent cannot split usefully', async () => {
  const { placement, client, input, dimensions, calls } = fixture(100, 30);
  const location = await placement.place(input('foreground'), client);

  expect(location.tabId).not.toBe('working');
  expect(dimensions.get('parent')).toEqual({ width: 100, height: 30 });
  expect(calls.some((call) => call[1] === 'split')).toBe(false);
});

it.each(['resize', 'insert', 'move', 'close'] as const)(
  'abandons an external %s during placement without mutating topology',
  async (change) => {
    const { placement, client, input, panes, dimensions, calls } = fixture(340, 100);
    let layouts = 0;
    const changedClient = async (arguments_: string[]) => {
      const response = await client(arguments_);
      if (arguments_[1] === 'layout' && ++layouts === 1) {
        if (change === 'resize') {
          dimensions.set('parent', { width: 200, height: 100 });
        } else if (change === 'insert') {
          panes.push({ ...panes[0]!, pane_id: 'unrelated', terminal_id: 'unrelated' });
          dimensions.set('unrelated', { width: 100, height: 100 });
        } else if (change === 'move') {
          panes[0]!.pane_id = 'moved-parent';
        } else {
          panes.length = 0;
        }
      }

      return response;
    };

    await expect(placement.place(input('foreground'), changedClient)).rejects.toThrow(
      /changed|moved|closed/,
    );
    expect(calls.some((call) => ['split', 'create'].includes(call[1]!))).toBe(false);
  },
);

it('does not reclaim a background tab after an unrelated pane joins it', async () => {
  const { placement, client, input, panes, dimensions } = fixture(340, 100);
  const first = await placement.place(input('background'), client);
  panes.push({
    pane_id: 'unrelated',
    terminal_id: 'unrelated',
    tab_id: first.tabId,
    workspace_id: first.workspaceId,
  });
  dimensions.set('unrelated', { width: 100, height: 50 });
  const second = await placement.place(input('background'), client);

  expect(second.tabId).not.toBe(first.tabId);
  expect(dimensions.get(first.paneId)).toEqual({ width: 340, height: 100 });
});

it('does not rebalance manual sizes or touch an unrelated foreground pane', async () => {
  const { placement, client, input, panes, dimensions, calls } = fixture(340, 100);
  const worker = await placement.place(input('foreground'), client);
  dimensions.set('parent', { width: 100, height: 100 });
  dimensions.set(worker.paneId, { width: 239, height: 100 });
  panes.push({
    pane_id: 'unrelated',
    terminal_id: 'unrelated',
    workspace_id: 'workspace',
    tab_id: 'working',
  });
  dimensions.set('unrelated', { width: 500, height: 500 });
  await placement.place(input('foreground'), client);

  expect(dimensions.get('parent')).toEqual({ width: 100, height: 100 });
  expect(dimensions.get('unrelated')).toEqual({ width: 500, height: 500 });
  expect(calls.some((call) => call[1] === 'resize')).toBe(false);
  expect(calls.findLast((call) => call[1] === 'split')).toEqual(
    expect.arrayContaining(['--pane', worker.paneId]),
  );
});

it.each(['resize', 'insert', 'move', 'close'] as const)(
  'refuses an external %s before rebalancing Tau splits',
  async (change) => {
    const { placement, client, input, panes, dimensions, calls } = fixture(340, 100);
    const first = await placement.place(input('foreground'), client);
    const previousCalls = calls.length;
    let checked = false;
    const changedClient = async (arguments_: string[]) => {
      const response = await client(arguments_);
      if (arguments_[1] === 'layout' && !checked) {
        checked = true;
        if (change === 'resize') {
          dimensions.set('parent', { width: 200, height: 100 });
        } else if (change === 'insert') {
          panes.push({ ...panes[0]!, pane_id: 'unrelated', terminal_id: 'unrelated' });
          dimensions.set('unrelated', { width: 100, height: 100 });
        } else if (change === 'move') {
          panes.find((pane) => pane.pane_id === first.paneId)!.pane_id = 'moved';
        } else {
          panes.splice(
            panes.findIndex((pane) => pane.pane_id === first.paneId),
            1,
          );
        }
      }

      return response;
    };

    await expect(placement.place(input('foreground'), changedClient)).rejects.toThrow(
      /changed|moved/,
    );
    expect(
      calls.slice(previousCalls).some((call) => ['split', 'resize', 'create'].includes(call[1]!)),
    ).toBe(false);
  },
);

it('does not retry or restore ratios after uncertain resize delivery', async () => {
  const { placement, client, input, calls } = fixture(340, 100);
  await placement.place(input('foreground'), client);
  const previousCalls = calls.length;
  const failedClient = async (arguments_: string[]) => {
    const response = await client(arguments_);
    if (arguments_[1] === 'resize') {
      throw new Error('Resize delivery uncertain');
    }

    return response;
  };

  await expect(placement.place(input('foreground'), failedClient)).rejects.toThrow(
    'Resize delivery uncertain',
  );
  const mutations = calls
    .slice(previousCalls)
    .filter((call) => ['split', 'resize', 'create', 'apply'].includes(call[1]!));
  expect(mutations).toHaveLength(1);
  expect(mutations[0]![1]).toBe('resize');
});

it('cancels queued placement within its own budget without waiting for another launch', async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const { placement, client, input, calls } = fixture(340, 100);
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const first = placement.place(input('background'), async (arguments_) => {
    if (arguments_[1] === 'current') {
      entered.resolve(undefined);
      await release.promise;
    }

    return client(arguments_);
  });
  await entered.promise;
  const abort = new AbortController();
  let rejected = false;
  const second = placement.place(input('background'), client, abort.signal).catch(() => {
    rejected = true;
  });
  abort.abort();
  await vi.runAllTimersAsync();
  const rejectedBeforeRelease = rejected;
  release.resolve(undefined);
  await Promise.all([first, second]);

  expect(rejectedBeforeRelease).toBe(true);
  expect(calls.filter((call) => call[1] === 'create')).toHaveLength(1);
});

it('does not split a released terminal or retry uncertain creation', async () => {
  const { placement, client, input, calls } = fixture(340, 100);
  const first = await placement.place(input('background'), client);
  placement.release(first.terminalId);
  const second = await placement.place(input('background'), client);

  expect(second.tabId).not.toBe(first.tabId);
  const failingClient = async (arguments_: string[]) => {
    if (arguments_[1] === 'split') {
      calls.push(arguments_);
      throw new Error('Delivery uncertain');
    }

    return client(arguments_);
  };
  await expect(placement.place(input('background'), failingClient)).rejects.toThrow(
    'Delivery uncertain',
  );
  expect(calls.filter((call) => call[1] === 'split')).toHaveLength(1);
});
