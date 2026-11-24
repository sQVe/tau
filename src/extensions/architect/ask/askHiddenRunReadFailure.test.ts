import { afterEach, expect, it, vi } from 'vitest';

import { takeStartTicket, useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { askFailedReason, askKeptClaimMessage, askUnconfirmedStopDetail } from './askHiddenRun.js';
import { ask, details, startFake, statuses } from './fixtures/askHarness.js';

const faults = vi.hoisted(() => ({ failMarkerRead: false }));

const namedPath = (path: unknown, name: string): boolean =>
  typeof path === 'string' && path.includes(name);

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  const faultyReaddir = (async (
    ...readArguments: Parameters<typeof original.readdir>
  ): Promise<unknown> => {
    if (faults.failMarkerRead && namedPath(readArguments[0], '/start')) {
      faults.failMarkerRead = false;

      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    }

    return original.readdir(...readArguments);
  }) as typeof original.readdir;

  return { ...original, readdir: faultyReaddir };
});

afterEach(() => {
  faults.failMarkerRead = false;
});

it('settles a lost reply after a failed first marker read and a confirmed exit', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  useFakeStartProcess(cleanup, 'gone');
  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      await takeStartTicket(commandArguments);

      faults.failMarkerRead = true;

      return { code: 0, killed: false, truncated: false, stdout: '', stderr: '' };
    }

    return hc.exec(command, commandArguments, options);
  };

  const result = await ask({ ...hc, exec }, root);

  expect(result).toMatchObject({ details: { status: 'failed', reason: askFailedReason } });
  expect(await statuses(root)).toEqual(['failed']);

  expect((await details(root))[0]).toContain(
    'The child adoption could not be read: EIO: i/o error',
  );

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('reports the read failure with the kept claim when the child stays unresolved', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  useFakeStartProcess(cleanup, 'unknown');
  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      await takeStartTicket(commandArguments);

      faults.failMarkerRead = true;

      return { code: 0, killed: false, truncated: false, stdout: '', stderr: '' };
    }

    return hc.exec(command, commandArguments, options);
  };

  const result = await ask({ ...hc, exec }, root);

  expect(result).toMatchObject({
    details: {
      status: 'needsOpen',
      reason: `${askKeptClaimMessage(root)} The child adoption could not be read: EIO: i/o error`,
    },
  });

  expect(await statuses(root)).toEqual(['running']);
  expect(await details(root)).toEqual([askUnconfirmedStopDetail]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});
