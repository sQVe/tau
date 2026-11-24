import { afterEach, expect, it, vi } from 'vitest';

import { useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { askKeptClaimMessage, askUnconfirmedStopDetail } from './askHiddenRun.js';
import { ask, details, failFirstWait, startFake, statuses } from './fixtures/askHarness.js';

const faults = vi.hoisted(() => ({ failClaimRelease: false }));

const namedPath = (path: unknown, name: string): boolean =>
  typeof path === 'string' && path.includes(name);

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  const faultyWriteFile = (async (
    ...writeArguments: Parameters<typeof original.writeFile>
  ): Promise<unknown> => {
    if (faults.failClaimRelease && namedPath(writeArguments[0], '.rewrite')) {
      throw new Error('The lock could not be rewritten.');
    }

    return original.writeFile(...writeArguments);
  }) as typeof original.writeFile;

  const faultyTruncate = (async (
    ...truncateArguments: Parameters<typeof original.truncate>
  ): Promise<unknown> => {
    if (faults.failClaimRelease && namedPath(truncateArguments[0], '/lock.')) {
      throw new Error('The lock could not be truncated.');
    }

    return original.truncate(...truncateArguments);
  }) as typeof original.truncate;

  return { ...original, writeFile: faultyWriteFile, truncate: faultyTruncate };
});

const resetFaults = (): void => {
  faults.failClaimRelease = false;
};

afterEach(resetFaults);

it('reports the claim release failure in the kept-claim message', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  useFakeStartProcess(cleanup, 'running', true);
  await recordSession(root);

  hc.reply('kill', JSON.stringify({ address: 't-ask', state: 'live' }));

  faults.failClaimRelease = true;

  const failure = await ask(failFirstWait(hc, new Error('The wait failed.')), root).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(askKeptClaimMessage(root));

  expect((failure as Error).message).toContain(
    'The claim could not be released: The lock could not be truncated.',
  );

  expect(await statuses(root)).toEqual(['running']);
  expect(await details(root)).toEqual([askUnconfirmedStopDetail]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});
