import { expect, it } from 'vitest';

import { herdrFake } from '../../../tests/herdrFake.js';
import { agentPane, fixture } from './fixtures/reviewFixture.js';

const notFound = () => new Error('herdr failed: {"error":{"code":"pane_not_found"}}');

const reviewTerminal = (herdr: ReturnType<typeof herdrFake>) => herdr.workers().at(-1)!;

it('runs the review at the new pane when the terminal moves before the command starts', async () => {
  const herdr = herdrFake();
  herdr.moveDuring('pane run');

  const { run, herdrCalls } = await fixture(herdr);
  const outcome = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  const runs = herdrCalls.filter(([, action]) => action === 'run').map((call) => call[2]);
  const closes = herdrCalls.filter(([, action]) => action === 'close');

  expect(runs).toHaveLength(2);
  expect(runs[1]).toBe(reviewTerminal(herdr).paneId);
  expect(runs[1]).not.toBe(runs[0]);
  expect(outcome.details).toMatchObject({ status: 'opened' });
  expect(closes).toEqual([]);
});

it('opens and closes nothing more when the moved terminal is gone', async () => {
  const herdr = herdrFake();
  herdr.failCall('pane run', notFound(), true);

  const { run, herdrCalls } = await fixture(herdr);
  const outcome = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);

  expect(outcome.details).toMatchObject({ status: 'opened' });
  expect(herdrCalls.filter(([, action]) => action === 'close')).toEqual([]);
});

it('closes only the pane of a tab review whose terminal left the tab', async () => {
  const herdr = herdrFake(100);
  herdr.moveDuring('pane run', 'other-tab');

  const { run, herdrCalls } = await fixture(herdr);
  const opened = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);

  const outcome = await run({
    action: 'collect',
    directory: (opened.details as { directory: string }).directory,
  });

  const closing = herdrCalls.filter(([, action]) => action === 'close' || action === 'focus');

  expect(outcome.details).toMatchObject({ status: 'reviewed' });
  expect(closing).toEqual([['pane', 'close', reviewTerminal(herdr).paneId]]);
});

it('runs nothing and closes nothing when the terminal is gone before the command', async () => {
  const herdr = herdrFake();
  herdr.exitWhenOpened();

  const { run, herdrCalls } = await fixture(herdr);
  const outcome = await run({ action: 'open', paths: ['.tau/slices/a.md'] }, agentPane);
  const actions = herdrCalls.map(([, action]) => action);

  expect(outcome.details).toMatchObject({ status: 'opened' });
  expect(actions).not.toContain('run');
  expect(actions).not.toContain('close');
});
