import { readdirSync } from 'node:fs';

import { expect, it, onTestFinished as finishTest, vi } from 'vitest';

import { setup } from './fixtures/controllerFixture.js';

vi.mock(import('node:fs'), { spy: true });

it('refuses a prepared launch while shutdown is still draining workers', async ({
  onTestFinished,
}) => {
  const listingEntered = Promise.withResolvers<undefined>();
  const releaseListing = Promise.withResolvers<undefined>();
  const cleanupEntered = Promise.withResolvers<undefined>();
  const releaseCleanup = Promise.withResolvers<undefined>();
  let pauseListing = false;
  let pauseCleanup = false;

  const fixture = setup(onTestFinished, 0, async (argumentsList) => {
    if (pauseListing && argumentsList[0] === 'agent' && argumentsList[1] === 'list') {
      pauseListing = false;
      listingEntered.resolve(undefined);
      await releaseListing.promise;
    }

    if (pauseCleanup && argumentsList[0] === 'pane' && argumentsList[1] === 'list') {
      pauseCleanup = false;
      cleanupEntered.resolve(undefined);
      await releaseCleanup.promise;
    }

    return '';
  });

  onTestFinished(() => {
    releaseListing.resolve(undefined);
    releaseCleanup.resolve(undefined);
  });

  await fixture.controller.launch(fixture.input);
  const recordsBefore = readdirSync(fixture.directory);
  const panesBefore = structuredClone(fixture.fake.layout.panes);
  pauseListing = true;
  const launching = fixture.controller.launch(fixture.input).catch((error: unknown) => error);
  await listingEntered.promise;
  pauseCleanup = true;
  const shutdown = fixture.controller.stopAll('reload');
  await cleanupEntered.promise;
  releaseListing.resolve(undefined);
  const launchResult = await launching;
  const recordsAfter = readdirSync(fixture.directory);
  const panesAfter = structuredClone(fixture.fake.layout.panes);
  releaseCleanup.resolve(undefined);
  await shutdown;

  expect(launchResult).toBeInstanceOf(Error);
  expect(String(launchResult)).toContain('Parent controller stopped');
  expect(recordsAfter).toEqual(recordsBefore);
  expect(panesAfter).toEqual(panesBefore);
  expect(fixture.calls.filter((call) => call[0] === 'layout')).toHaveLength(1);
});

it('caps live workers per controller and admits again after confirmed cleanup', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished, 0, undefined, undefined, 1);

  const launched = await fixture.controller.launch(fixture.input);
  const recordsBefore = readdirSync(fixture.directory);
  const panesBefore = structuredClone(fixture.fake.layout.panes);
  const refused = fixture.controller.launch(fixture.input);

  await expect(refused).rejects.toThrow('capacity full');
  await expect(refused).rejects.toThrow(launched.name);
  await expect(refused).rejects.toThrow(new Date(launched.deadline).toISOString());

  expect(readdirSync(fixture.directory)).toEqual(recordsBefore);
  expect(fixture.fake.layout.panes).toEqual(panesBefore);
  expect(fixture.calls.filter((call) => call[0] === 'layout')).toHaveLength(1);
  await fixture.controller.cancel(launched.taskId, fixture.input.parentSessionId);
  fixture.fake.state.stopped = false;
  const replacement = await fixture.controller.launch(fixture.input);

  expect(replacement.state).toBe('starting');
  expect(fixture.calls.filter((call) => call[0] === 'layout')).toHaveLength(2);
});

it('admits another worker after cleanup fails its terminal identity check', async ({
  onTestFinished,
}) => {
  const fixture = setup(onTestFinished, 0, undefined, undefined, 1);
  const launched = await fixture.controller.launch(fixture.input);
  fixture.fake.layout.panes[1]!.terminal_id = 'replacement-terminal';
  const callsBefore = fixture.calls.length;

  const cancelled = await fixture.controller.cancel(launched.taskId, fixture.input.parentSessionId);

  expect(cancelled).toMatchObject({
    state: 'cleanupUnconfirmed',
    recovery: {
      directory: launched.directory,
      nativeSessionFile: launched.nativeSessionFile,
      paneId: 'worker-1',
    },
  });

  expect(fixture.calls.slice(callsBefore).filter((call) => call[1] === 'close')).toEqual([]);

  const replacement = await fixture.controller.launch(fixture.input);

  expect(replacement.state).toBe('starting');

  expect(fixture.controller.status(launched.taskId, fixture.input.parentSessionId)).toMatchObject({
    state: 'cleanupUnconfirmed',
    recovery: cancelled.recovery,
  });
});

it.each([
  { configured: undefined, capacity: 12 },
  { configured: 3, capacity: 3 },
])(
  'allows $capacity live workers and refuses the next when capacity is $configured',
  async ({ configured, capacity }) => {
    const fixture = setup(finishTest, 0, undefined, undefined, configured);

    for (let index = 0; index < capacity; index += 1) {
      await fixture.controller.launch(fixture.input);
    }

    await expect(fixture.controller.launch(fixture.input)).rejects.toThrow('capacity full');
  },
);
