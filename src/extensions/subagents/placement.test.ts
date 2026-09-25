import { expect, it, vi, onTestFinished } from 'vitest';

import { placementFixture as fixture } from './fixtures/placement.js';
import { splitDirection } from './placement.js';
import { requireObject, result } from './terminal.js';

const minimumPane = { width: 82, height: 24 };

it.each([
  [100, 100, 'down'],
  [400, 30, 'right'],
  [400, 100, 'right'],
  [164, 48, 'right'],
  [163, 47, undefined],
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
  },
);

it('serializes concurrent launches instead of splitting below the useful floor', async () => {
  const { placement, client, input, panes, dimensions } = fixture(250, 30);
  const entered = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();

  const delayed = async (argumentsList: string[]) => {
    if (argumentsList[1] === 'split') {
      entered.resolve(undefined);
      await resume.promise;
    }

    return client(argumentsList);
  };

  const first = placement.place(input('foreground'), delayed);
  await entered.promise;
  const second = placement.place(input('foreground'), client);
  resume.resolve(undefined);
  const workers = await Promise.all([first, second]);

  expect(workers[0].tabId).toBe('working');
  expect(workers[1].tabId).not.toBe('working');
  expect(panes).toHaveLength(3);

  for (const bounds of dimensions.values()) {
    expect(bounds.width).toBeGreaterThanOrEqual(minimumPane.width);
    expect(bounds.height).toBeGreaterThanOrEqual(minimumPane.height);
  }
});

it.each([
  [407, 60, 4],
  [488, 100, 5],
])(
  'keeps every foreground pane useful at %s x %s with %s workers under herdr rounding',
  async (width, height, workers) => {
    const { placement, client, input, panes, dimensions } = fixture(width, height);

    await Promise.all(
      Array.from({ length: workers }, () => placement.place(input('foreground'), client)),
    );

    for (const pane of panes) {
      const bounds = dimensions.get(pane.pane_id)!;
      expect(bounds.width).toBeGreaterThanOrEqual(minimumPane.width);
      expect(bounds.height).toBeGreaterThanOrEqual(minimumPane.height);
    }
  },
);

it('releases a confirmed terminal when creation is cancelled', async () => {
  const { placement, client, input, dimensions } = fixture(340, 100);
  const abort = new AbortController();
  let created: string | undefined;

  await expect(
    placement.place(
      {
        ...input('foreground'),
        onCreated: (location) => {
          created = location.terminalId;
          abort.abort();
        },
      },
      client,
      abort.signal,
    ),
  ).rejects.toThrow(/aborted|cancelled/);

  dimensions.set('parent', { width: 100, height: 30 });
  const replacement = await placement.place(input('foreground'), client);

  expect(created).toBeDefined();
  expect(replacement.tabId).not.toBe('working');
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

it('uses a background tab without unzooming the parent', async () => {
  const { placement, client, input, calls } = fixture(340, 100);

  const zoomedClient = async (argumentsList: string[]) => {
    const response = await client(argumentsList);

    if (argumentsList[1] === 'layout') {
      const parsed = result(response);
      const layout = requireObject(parsed.layout);

      return JSON.stringify({ result: { ...parsed, layout: { ...layout, zoomed: true } } });
    }

    return response;
  };

  const location = await placement.place(input('foreground'), zoomedClient);

  expect(location.tabId).not.toBe('working');
  expect(calls.some((call) => call[1] === 'split')).toBe(false);
});

it('refuses a worker tab below the useful floor without changing panes', async () => {
  const { placement, client, input, panes, calls } = fixture(81, 23);

  await expect(placement.place(input('background'), client)).rejects.toThrow('too small');

  expect(panes).toHaveLength(1);
  expect(calls.some((call) => ['split', 'create'].includes(call[1]!))).toBe(false);
});

it.each(['resize', 'insert', 'move', 'close'] as const)(
  'abandons an external %s during placement without mutating topology',
  async (change) => {
    const { placement, client, input, panes, dimensions, calls } = fixture(340, 100);
    let layouts = 0;

    const changedClient = async (argumentsList: string[]) => {
      const response = await client(argumentsList);

      if (argumentsList[1] === 'layout' && ++layouts === 1) {
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

it.each([1, 2])(
  'refuses malformed pane inventory on layout read %s without creating a worker',
  async (invalidRead) => {
    const { placement, client, input, panes, calls } = fixture(340, 100);
    let reads = 0;

    const malformedClient = async (argumentsList: string[]) => {
      const response = await client(argumentsList);

      if (argumentsList[1] !== 'layout') {
        return response;
      }

      reads += 1;

      if (reads !== invalidRead) {
        return response;
      }

      const parsed = result(response);
      const layout = requireObject(parsed.layout);

      return JSON.stringify({ result: { ...parsed, layout: { ...layout, panes: null } } });
    };

    await expect(placement.place(input('foreground'), malformedClient)).rejects.toThrow(
      'Missing herdr layout panes.',
    );

    expect(panes).toHaveLength(1);
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

it('splits the largest eligible pane without touching unrelated panes', async () => {
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

  expect(calls.findLast((call) => call[1] === 'split')).toEqual(
    expect.arrayContaining(['--pane', worker.paneId]),
  );
});

it('cancels queued placement within its own budget without waiting for another launch', async () => {
  vi.useFakeTimers();

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const { placement, client, input, calls } = fixture(340, 100);
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();

  const first = placement.place(input('background'), async (argumentsList) => {
    if (argumentsList[1] === 'current') {
      entered.resolve(undefined);
      await release.promise;
    }

    return client(argumentsList);
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

  const failingClient = async (argumentsList: string[]) => {
    if (argumentsList[1] === 'split') {
      calls.push(argumentsList);
      throw new Error('Delivery uncertain');
    }

    return client(argumentsList);
  };

  await expect(placement.place(input('background'), failingClient)).rejects.toThrow(
    'Delivery uncertain',
  );

  expect(calls.filter((call) => call[1] === 'split')).toHaveLength(1);
});

it('places the first foreground worker beside the parent in 193 columns and 60 rows', async () => {
  const { placement, client, input, dimensions } = fixture(193, 60);

  await placement.place(input('foreground'), client);

  expect([...dimensions.values()].map((bounds) => bounds.height)).toEqual([60, 60]);
});

it('stacks the second background worker below the first in 193 columns and 60 rows', async () => {
  const { placement, client, input, dimensions } = fixture(193, 60);

  await placement.place(input('background'), client);
  const second = await placement.place(input('background'), client);

  expect(dimensions.get(second.paneId)).toEqual({ width: 193, height: 30 });
});
