import { expect, it } from 'vitest';

import { fixture, layoutInfo, paneInfo, tabInfo } from './fixtures/reviewFixture.js';
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

// Models a review terminal that moves to pane w2:p9 once the run on its first pane fails.
const movingHerdr = (options: {
  terminalId: string;
  firstPane: string;
  tab: boolean;
  afterMove: 'moved' | 'closed';
}) => {
  const state = { moved: false };

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

    if (action === 'run' && target === options.firstPane) {
      state.moved = true;

      throw notFound();
    }

    if (action === 'process-info') {
      return JSON.stringify({
        result: { process_info: { foreground_processes: [{ pid: 4242 }] } },
      });
    }

    return '';
  };

  return herdr;
};

it('runs the review at the new pane when the terminal moves before the command starts', async () => {
  const herdr = movingHerdr({
    terminalId: 't2',
    firstPane: 'w:p2',
    tab: false,
    afterMove: 'moved',
  });

  const { run, herdrCalls } = await fixture(herdr);
  const outcome = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
  const runs = herdrCalls.filter(([, action]) => action === 'run').map((call) => call[2]);
  const closes = herdrCalls.filter(([, action]) => action === 'close');

  expect(runs).toEqual(['w:p2', 'w2:p9']);
  expect(outcome.details).toMatchObject({ status: 'opened' });
  expect(closes).toEqual([]);
});

it('opens and closes nothing more when the moved terminal is gone', async () => {
  const herdr = movingHerdr({
    terminalId: 't2',
    firstPane: 'w:p2',
    tab: false,
    afterMove: 'closed',
  });

  const { run, herdrCalls } = await fixture(herdr);
  const outcome = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');

  expect(outcome.details).toMatchObject({ status: 'opened' });
  expect(herdrCalls.filter(([, action]) => action === 'close')).toEqual([]);
});

it('closes only the pane of a tab review whose terminal left the tab', async () => {
  const herdr = movingHerdr({
    terminalId: 't3',
    firstPane: 'w:p3',
    tab: true,
    afterMove: 'moved',
  });

  const { run, herdrCalls } = await fixture(herdr);
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');

  const outcome = await run({
    action: 'collect',
    directory: (opened.details as { directory: string }).directory,
  });

  const closing = herdrCalls.filter(([, action]) => action === 'close' || action === 'focus');

  expect(outcome.details).toMatchObject({ status: 'reviewed' });
  expect(closing).toEqual([['pane', 'close', 'w2:p9']]);
});

it('runs nothing and closes nothing when the terminal is gone before the command', async () => {
  const { run, herdrCalls } = await fixture(async (argumentsList) => {
    const [, action] = argumentsList;

    if (action === 'split') {
      return paneInfo;
    }

    return action === 'list' ? listing('', '', '') : '';
  });

  const outcome = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, 'w:p1');
  const actions = herdrCalls.map(([, action]) => action);

  expect(outcome.details).toMatchObject({ status: 'opened' });
  expect(actions).not.toContain('run');
  expect(actions).not.toContain('close');
});
