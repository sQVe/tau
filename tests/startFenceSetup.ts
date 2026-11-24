import { acquireStartFence } from '../src/extensions/architect/startFence/startFence.js';
import type { StartFence } from '../src/extensions/architect/startFence/startFence.js';
import { takeStartTicket } from './startTicketFake.js';

export const acquiredFence = async (root: string): Promise<StartFence> => {
  const acquisition = await acquireStartFence(root);

  if (acquisition.kind !== 'acquired') {
    throw new Error('The start fence was not acquired.');
  }

  return acquisition.fence;
};

export const takenFence = async (root: string): Promise<StartFence> => {
  const fence = await acquiredFence(root);

  await fence.createTicket();

  const taken = await takeStartTicket(fence.wrapArgv(['true']));

  if (!taken) {
    throw new Error('The start ticket was not taken.');
  }

  return fence;
};
