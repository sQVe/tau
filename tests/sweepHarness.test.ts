import { expect, it, onTestFinished } from 'vitest';

import {
  createSweepFixture,
  MergedListAbortError,
  MissingMergedListSignalError,
} from './sweepHarness.js';

const mergedCommand = ['pr', 'list'];

const turn = (): Promise<'pending'> =>
  new Promise((resolve) => {
    setImmediate(() => {
      resolve('pending');
    });
  });

it('keeps a gated merged call pending until its signal aborts', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const gate = fixture.gateMergedList();
  const controller = new AbortController();
  const reason = new Error('stopped');

  const call = fixture.fake.exec('gh', mergedCommand, { signal: controller.signal });

  await gate.reached;

  const settled = call.then(
    () => 'settled',
    () => 'settled',
  );

  const first = await Promise.race([settled, turn()]);

  expect(first).toBe('pending');

  controller.abort(reason);

  await expect(call).rejects.toBe(reason);
});

it('fails a gated merged call that passes no signal', async () => {
  const fixture = await createSweepFixture(onTestFinished);

  fixture.gateMergedList();

  await expect(fixture.fake.exec('gh', mergedCommand, undefined)).rejects.toBeInstanceOf(
    MissingMergedListSignalError,
  );
});

it('fails a gated merged call whose signal is already aborted', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const controller = new AbortController();
  const reason = new Error('stopped');

  fixture.gateMergedList();
  controller.abort(reason);

  await expect(fixture.fake.exec('gh', mergedCommand, { signal: controller.signal })).rejects.toBe(
    reason,
  );
});

it('rejects a gated merged call aborted with a non-Error reason', async () => {
  const fixture = await createSweepFixture(onTestFinished);
  const gate = fixture.gateMergedList();
  const controller = new AbortController();

  const call = fixture.fake.exec('gh', mergedCommand, { signal: controller.signal });

  await gate.reached;
  controller.abort('stopped');

  await expect(call).rejects.toBeInstanceOf(MergedListAbortError);
});
