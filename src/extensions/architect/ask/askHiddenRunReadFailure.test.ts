import { afterEach, expect, it, vi } from 'vitest';

import {
  armFileSystemFault,
  pathNamed,
  resetFileSystemFaults,
} from '../../../../tests/fileSystemFaultsFake.js';
import { takeStartTicket, useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { askFailedReason, askKeptClaimMessage, askUnconfirmedStopDetail } from './askHiddenRun.js';
import { ask, details, startFake, statuses } from './fixtures/askHarness.js';

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();
  const { takeFileSystemFault } = await import('../../../../tests/fileSystemFaultsFake.js');

  const faultyReaddir = (async (
    ...readArguments: Parameters<typeof original.readdir>
  ): Promise<unknown> => {
    const fault = takeFileSystemFault('readdir', readArguments[0]);

    if (fault !== undefined) {
      throw fault;
    }

    return original.readdir(...readArguments);
  }) as typeof original.readdir;

  return { ...original, readdir: faultyReaddir };
});

afterEach(resetFileSystemFaults);

const armMarkerReadFault = (): void => {
  armFileSystemFault({
    operation: 'readdir',
    matches: pathNamed('/start'),
    once: true,
    error: () => Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }),
  });
};

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
      armMarkerReadFault();

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
      armMarkerReadFault();

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
