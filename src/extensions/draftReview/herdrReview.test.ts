import { expect, it } from 'vitest';

import { comment, fixture, layoutInfo, paneInfo, tabInfo } from './fixtures/reviewFixture.js';
import type { Herdr } from './fixtures/reviewFixture.js';

const notFound = () => new Error('herdr failed: {"error":{"code":"pane_not_found"}}');

const listing = (terminalId: string, paneId: string, tabId: string) =>
  JSON.stringify({
    result: {
      panes: [
        { pane_id: 'w:p1', terminal_id: 't1', workspace_id: 'w', tab_id: 'w:t1' },
        ...(terminalId === ''
          ? []
          : [{ pane_id: paneId, terminal_id: terminalId, workspace_id: 'w2', tab_id: tabId }]),
      ],
    },
  });

// Models a review terminal that moves to pane w2:p9 once the run or the wait on its first pane
// fails.
const movingHerdr = (options: {
  terminalId: string;
  firstPane: string;
  tab: boolean;
  afterMove: 'moved' | 'closed';
  onSecondWait: () => Promise<void>;
  movesAt?: 'run' | 'wait-output';
}) => {
  const movesAt = options.movesAt ?? 'wait-output';

  const state = { moved: false, waits: [] as string[] };

  const herdr: Herdr = async (argumentsList) => {
    const [, action, target] = argumentsList;

    if (action === 'layout') {
      return layoutInfo(options.tab ? 100 : 200);
    }

    if (action === 'split') {
      return paneInfo;
    }

    if (action === 'create') {
      return tabInfo;
    }

    if (action === 'list') {
      if (!state.moved) {
        return listing(options.terminalId, options.firstPane, options.tab ? 'w:t2' : 'w:t1');
      }

      return options.afterMove === 'closed'
        ? listing('', '', '')
        : listing(options.terminalId, 'w2:p9', 'w2:t1');
    }

    if (action === 'run' && movesAt === 'run' && target === options.firstPane) {
      state.moved = true;

      throw notFound();
    }

    if (action === 'wait-output') {
      state.waits.push(target ?? '');

      if (target === options.firstPane && movesAt === 'wait-output') {
        state.moved = true;

        throw notFound();
      }

      await options.onSecondWait();
    }

    return '';
  };

  return { herdr, state };
};

it('keeps waiting at the new pane when the review terminal moves, then collects', async () => {
  const hooks: { second?: () => Promise<void> } = {};
  const seen: { deletedAtSecondWait?: string[] } = {};

  const { herdr, state } = movingHerdr({
    terminalId: 't2',
    firstPane: 'w:p2',
    tab: false,
    afterMove: 'moved',
    onSecondWait: async () => hooks.second?.(),
  });

  const context = await fixture(herdr);

  hooks.second = async () => {
    seen.deletedAtSecondWait = await context.deleted();
    await context.setSession([comment('on-a', 'slices/a.md')]);
  };

  const outcome = await context.run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');
  const calls = context.herdrCalls;

  expect(state.waits).toEqual(['w:p2', 'w2:p9']);
  expect(calls.filter(([, action]) => action === 'run')).toHaveLength(1);
  expect(calls.filter(([, action]) => action === 'close')).toEqual([['pane', 'close', 'w2:p9']]);
  expect(seen.deletedAtSecondWait).toEqual([]);
  expect(outcome.details).toMatchObject({ status: 'reviewed', comments: [{ content: 'on-a' }] });
  expect(await context.deleted()).toEqual(['on-a']);
});

it('runs the review at the new pane when the terminal moves before the command starts', async () => {
  const { herdr, state } = movingHerdr({
    terminalId: 't2',
    firstPane: 'w:p2',
    tab: false,
    afterMove: 'moved',
    onSecondWait: async () => undefined,
    movesAt: 'run',
  });

  const { run, herdrCalls } = await fixture(herdr);
  const outcome = await run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');
  const runs = herdrCalls.filter(([, action]) => action === 'run').map((call) => call[2]);
  const closes = herdrCalls.filter(([, action]) => action === 'close');

  expect(runs).toEqual(['w:p2', 'w2:p9']);
  expect(state.waits).toEqual(['w2:p9']);
  expect(outcome.details).toMatchObject({ status: 'reviewed' });
  expect(closes).toEqual([['pane', 'close', 'w2:p9']]);
});

it('ends the review and closes nothing when the moved terminal is gone', async () => {
  const { herdr, state } = movingHerdr({
    terminalId: 't2',
    firstPane: 'w:p2',
    tab: false,
    afterMove: 'closed',
    onSecondWait: async () => undefined,
  });

  const { run, herdrCalls } = await fixture(herdr);
  const outcome = await run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');

  expect(state.waits).toEqual(['w:p2']);
  expect(outcome.details).toMatchObject({ status: 'reviewed' });
  expect(herdrCalls.filter(([, action]) => action === 'close')).toEqual([]);
});

it('closes only the pane of a tab review whose terminal left the tab', async () => {
  const { herdr } = movingHerdr({
    terminalId: 't3',
    firstPane: 'w:p3',
    tab: true,
    afterMove: 'moved',
    onSecondWait: async () => undefined,
  });

  const { run, herdrCalls } = await fixture(herdr);
  const outcome = await run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');
  const closing = herdrCalls.filter(([, action]) => action === 'close' || action === 'focus');

  expect(outcome.details).toMatchObject({ status: 'reviewed' });
  expect(closing).toEqual([['pane', 'close', 'w2:p9']]);
});

it('closes the tab of a tab review whose terminal is still in it', async () => {
  const { run, herdrCalls } = await fixture(async (argumentsList) => {
    const [, action] = argumentsList;

    if (action === 'layout') {
      return layoutInfo(100);
    }

    return action === 'create' ? tabInfo : '';
  });

  await run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');

  expect(herdrCalls.slice(-2)).toEqual([
    ['tab', 'close', 'w:t2'],
    ['tab', 'focus', 'w:t1'],
  ]);
});

it('does nothing at cleanup when the finished terminal is already gone', async () => {
  const state = { gone: false };

  const { run, herdrCalls } = await fixture(async (argumentsList) => {
    const [, action] = argumentsList;

    if (action === 'split') {
      return paneInfo;
    }

    if (action === 'wait-output') {
      state.gone = true;
    }

    return action === 'list' && state.gone ? listing('', '', '') : '';
  });

  const outcome = await run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');

  expect(outcome.details).toMatchObject({ status: 'reviewed' });
  expect(herdrCalls.filter(([, action]) => action === 'close')).toEqual([]);
});

it('runs nothing and closes nothing when the terminal is gone before the command', async () => {
  const { run, herdrCalls } = await fixture(async (argumentsList) => {
    const [, action] = argumentsList;

    if (action === 'split') {
      return paneInfo;
    }

    return action === 'list' ? listing('', '', '') : '';
  });

  const outcome = await run({ action: 'review', paths: ['.tau/slices/a.md'] }, 'w:p1');
  const actions = herdrCalls.map(([, action]) => action);

  expect(outcome.details).toMatchObject({ status: 'reviewed' });
  expect(actions).not.toContain('run');
  expect(actions).not.toContain('wait-output');
  expect(actions).not.toContain('close');
});
