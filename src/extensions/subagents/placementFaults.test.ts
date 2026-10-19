import { expect, it } from 'vitest';

import { placementFixture as fixture } from './fixtures/placement.js';

const settlesWithin = async (promise: Promise<unknown>, milliseconds: number) => {
  const timeout = Symbol('timeout');

  const winner = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise<symbol>((resolve) => {
      setTimeout(() => {
        resolve(timeout);
      }, milliseconds);
    }),
  ]);

  return winner !== timeout;
};

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

// Changes one herdr reply, chosen by its argument list, before the placement reads it.
const rewriting =
  (
    client: (argumentsList: string[]) => Promise<string>,
    rewrite: (argumentsList: string[], reply: Record<string, unknown>) => unknown,
  ) =>
  async (argumentsList: string[]) => {
    const reply = JSON.parse(await client(argumentsList)) as Record<string, unknown>;

    return JSON.stringify(rewrite(argumentsList, reply));
  };

it.each([
  [undefined, ['--current']],
  ['', ['--current']],
  ['parent', ['--pane', 'parent']],
])('finds the parent pane of a launch from %j', async (parentPane, expected) => {
  const { placement, client, input, calls } = fixture(340, 100);

  await placement.place(
    { ...input('background'), ...(parentPane === undefined ? {} : { parentPane }) },
    client,
  );

  expect(calls.find((call) => call[1] === 'current')).toEqual(['pane', 'current', ...expected]);
});

it('does not queue or call herdr for a launch that is already cancelled', async () => {
  const { placement, client, input, calls } = fixture(340, 100);
  const held = Promise.withResolvers<undefined>();
  const abort = new AbortController();
  const queue = placement.close(() => held.promise);

  abort.abort();

  const cancelled = placement.place(input('background'), client, abort.signal);

  expect(await settlesWithin(cancelled, 200)).toBe(true);
  held.resolve(undefined);
  await queue;
  await pause(20);
  expect(calls).toEqual([]);
});

it('stops calling herdr once the launch is cancelled', async () => {
  const { placement, client, input, calls } = fixture(340, 100);
  const abort = new AbortController();

  const cancelling = async (argumentsList: string[]) => {
    const reply = await client(argumentsList);

    abort.abort();

    return reply;
  };

  await expect(placement.place(input('background'), cancelling, abort.signal)).rejects.toThrow(
    /aborted|cancelled/,
  );

  await pause(50);

  expect(calls.map((call) => call[1])).toEqual(['current']);
});

it('stops splitting a pane whose launch was cancelled after it was placed', async () => {
  const { placement, client, input } = fixture(340, 100);
  const first = await placement.place(input('background'), client);
  const abort = new AbortController();

  const second = placement.place(
    {
      ...input('background'),
      labelCall: async (argumentsList) => {
        abort.abort();

        return client(argumentsList);
      },
    },
    client,
    abort.signal,
  );

  await expect(second).rejects.toThrow(/aborted|cancelled/);
  await placement.close(() => Promise.resolve());

  const third = await placement.place(input('background'), client);

  expect(third.tabId).not.toBe(first.tabId);
});

const targetMoved = async (
  change: (layout: Record<string, unknown>) => Record<string, unknown>,
) => {
  const { placement, client, input, calls } = fixture(340, 100);
  let layouts = 0;

  const moving = rewriting(client, (argumentsList, reply) => {
    if (argumentsList[1] !== 'layout') {
      return reply;
    }

    layouts += 1;

    const result = reply.result as { layout: Record<string, unknown> };

    return layouts === 1 ? { result: { layout: change(result.layout) } } : reply;
  });

  const failure = await placement
    .place(input('foreground'), moving)
    .catch((error: unknown) => error);

  return { failure, changes: calls.filter((call) => ['apply', 'move'].includes(call[1] ?? '')) };
};

it('refuses a split when the target pane is no longer in its tab', async () => {
  const { failure, changes } = await targetMoved((layout) => ({ ...layout, tab_id: 'elsewhere' }));

  expect(String(failure)).toContain('Placement target');
  expect(changes).toEqual([]);
});

it('refuses a split when the target pane is no longer in its workspace', async () => {
  const { failure, changes } = await targetMoved((layout) => ({
    ...layout,
    workspace_id: 'other',
  }));

  expect(String(failure)).toContain('Placement target');
  expect(changes).toEqual([]);
});

const parentMoved = async (change: (pane: Record<string, string>) => Record<string, string>) => {
  const { placement, client, input, calls } = fixture(340, 100);
  let listings = 0;

  const moving = rewriting(client, (argumentsList, reply) => {
    if (argumentsList[1] !== 'list') {
      return reply;
    }

    listings += 1;

    const result = reply.result as { panes: Record<string, string>[] };

    return listings === 2 ? { result: { panes: result.panes.map(change) } } : reply;
  });

  const failure = await placement
    .place(input('background'), moving)
    .catch((error: unknown) => error);

  return { failure, tabs: calls.filter((call) => call[1] === 'apply') };
};

it('refuses to create a tab when the parent changed panes during placement', async () => {
  const { failure, tabs } = await parentMoved((pane) => ({ ...pane, pane_id: 'parent-moved' }));

  expect(String(failure)).toContain('Parent moved');
  expect(tabs).toEqual([]);
});

it('refuses to create a tab when the parent changed workspace during placement', async () => {
  const { failure, tabs } = await parentMoved((pane) => ({ ...pane, workspace_id: 'other' }));

  expect(String(failure)).toContain('Parent moved');
  expect(tabs).toEqual([]);
});

it('splits the larger-area owned pane even when another pane is more elongated', async () => {
  const { placement, client, input, dimensions, calls } = fixture(340, 100);
  const first = await placement.place(input('background'), client);
  const second = await placement.place(input('background'), client);
  dimensions.set(first.paneId, { width: 100, height: 100 });
  dimensions.set(second.paneId, { width: 239, height: 30 });

  await placement.place(input('background'), client);

  expect(calls.findLast((call) => call[1] === 'move')).toEqual(
    expect.arrayContaining(['--target-pane', first.paneId]),
  );
});

it('does not reuse the tab of a worker pane that moved to another workspace', async () => {
  const { placement, client, input, panes } = fixture(340, 100);
  const first = await placement.place(input('background'), client);

  panes.find((pane) => pane.pane_id === first.paneId)!.workspace_id = 'other';

  const second = await placement.place(input('background'), client);

  expect(second.tabId).not.toBe(first.tabId);
});

it('does not split the parent for a background worker after the parent joined a worker tab', async () => {
  const { placement, client, input, parent } = fixture(340, 100);
  const first = await placement.place(input('background'), client);

  parent.tab_id = first.tabId;

  const second = await placement.place(input('background'), client);

  expect(second.tabId).not.toBe(first.tabId);
});

it('splits only the parent when its tab also holds a worker pane owned for a background tab', async () => {
  const { placement, client, input, parent, dimensions, calls } = fixture(340, 100);
  const first = await placement.place(input('background'), client);

  parent.tab_id = first.tabId;
  dimensions.set('parent', { width: 170, height: 60 });
  dimensions.set(first.paneId, { width: 340, height: 100 });

  await placement.place(input('foreground'), client);

  expect(calls.findLast((call) => call[1] === 'move')).toEqual(
    expect.arrayContaining(['--target-pane', 'parent']),
  );
});

it('places a foreground worker beside the parent after the shown worker left its tab', async () => {
  const { placement, client, input, panes } = fixture(340, 100);
  const first = await placement.place(input('foreground'), client);

  panes.find((pane) => pane.pane_id === first.paneId)!.tab_id = 'elsewhere';

  const second = await placement.place(input('foreground'), client);

  expect(second).toMatchObject({ tabId: 'working', visibility: 'foreground' });
});

it('keeps the tab label of a worker when a worker of another tab is released', async () => {
  const { placement, client, input, labels, calls } = fixture(100, 30);
  const first = await placement.place(input('background', 'scout-as'), client);
  const second = await placement.place(input('background', 'reviewer-so'), client);

  expect(second.tabId).not.toBe(first.tabId);

  placement.release(second.terminalId, client);
  await placement.close(() => Promise.resolve());

  expect(calls.some((call) => call[0] === 'tab' && call[1] === 'rename')).toBe(false);
  expect(labels.get(first.tabId)).toBe('scout-as');
});
