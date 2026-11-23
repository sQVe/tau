import { expect, it } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { takeStartTicket, useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { architectLockPath, holdArchitectLock } from '../lock.js';
import { acquireStartFence } from './startFence.js';

it('keeps a positive takeover observation after the adopter releases its lock', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const processControl = useFakeStartProcess(onTestFinished, 'running', true);
  const acquisition = await acquireStartFence(root);

  if (acquisition.kind !== 'acquired') {
    throw new Error('The start fence was not acquired.');
  }

  const { fence } = acquisition;

  await fence.createTicket();

  expect(await takeStartTicket(fence.wrapArgv(['true']))).toBe(true);

  const holder = await readLiveLockHolder(architectLockPath(root));

  if (holder === undefined) {
    throw new Error('The claim is not live.');
  }

  const adopted = await holdArchitectLock(root, holder.token);

  expect(await fence.abandon()).toEqual({ takenOver: true });

  await adopted.release();

  const second = await fence.abandon();

  expect(second).toEqual({ takenOver: true });

  const finished = await fence.finish({ adopted: false, stopAttempted: second.takenOver });

  expect(finished).toEqual({ kept: true });
  expect(processControl.signals).toEqual([]);
});
