import { afterEach, expect, it, vi } from 'vitest';

import { succeededResult } from '../../../../tests/execFake.js';
import {
  armFileSystemFault,
  pathNamed,
  resetFileSystemFaults,
} from '../../../../tests/fileSystemFaultsFake.js';
import { takeStartTicket, useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { askRecordPath, readAskRecord, readAskRecords, writeAskRecord } from '../record.js';
import { askKeptClaimMessage, askTimeoutReleaseDetail } from './askHiddenRun.js';
import {
  ask,
  details,
  endedWait,
  failFirstWait,
  startFake,
  statuses,
} from './fixtures/askHarness.js';

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();
  const { takeFileSystemFault } = await import('../../../../tests/fileSystemFaultsFake.js');

  const faultyWriteFile = (async (
    ...writeArguments: Parameters<typeof original.writeFile>
  ): Promise<unknown> => {
    const fault = takeFileSystemFault('writeFile', writeArguments[0]);

    if (fault !== undefined) {
      throw fault;
    }

    return original.writeFile(...writeArguments);
  }) as typeof original.writeFile;

  const faultyReadFile = (async (
    ...readArguments: Parameters<typeof original.readFile>
  ): Promise<unknown> => {
    const fault = takeFileSystemFault('readFile', readArguments[0]);

    if (fault !== undefined) {
      throw fault;
    }

    return original.readFile(...readArguments);
  }) as typeof original.readFile;

  const faultyTruncate = (async (
    ...truncateArguments: Parameters<typeof original.truncate>
  ): Promise<unknown> => {
    const fault = takeFileSystemFault('truncate', truncateArguments[0]);

    if (fault !== undefined) {
      throw fault;
    }

    return original.truncate(...truncateArguments);
  }) as typeof original.truncate;

  return {
    ...original,
    readFile: faultyReadFile,
    writeFile: faultyWriteFile,
    truncate: faultyTruncate,
  };
});

afterEach(resetFileSystemFaults);

const armClaimReleaseFault = (): void => {
  armFileSystemFault({
    operation: 'writeFile',
    matches: pathNamed('.rewrite'),
    error: () => new Error('The lock could not be rewritten.'),
  });

  armFileSystemFault({
    operation: 'truncate',
    matches: pathNamed('/lock.'),
    error: () => new Error('The lock could not be truncated.'),
  });
};

const failSecondRecordRead = (path: string): void => {
  let reads = 0;

  armFileSystemFault({
    operation: 'readFile',
    matches: (candidate) => candidate === path && (reads += 1) === 2,
    error: () => new Error('The ask record was read a second time.'),
  });
};

it('reports the kept claim when the release fails after a stopped child', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  useFakeStartProcess(cleanup, 'running', true);
  await recordSession(root);

  hc.reply('kill', JSON.stringify({ address: 't-ask', state: 'live' }));

  armClaimReleaseFault();

  const waitFailure = new Error('The wait failed.');
  const failure = await ask(failFirstWait(hc, waitFailure), root).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  expect((failure as Error).message).toBe(
    `${askKeptClaimMessage(root)} The claim could not be released: The lock could not be truncated.`,
  );

  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toContain(waitFailure.message);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('returns a sent answer without reading the record a second time', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const waitFailure = new Error('The wait failed.');
  let askId: string | undefined;

  useFakeStartProcess(cleanup, 'running', true);
  await recordSession(root);

  armClaimReleaseFault();

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      const result = await hc.exec(command, commandArguments, options);
      const { records } = await readAskRecords(root);

      askId = records[0]?.askId;

      return result;
    }

    if (command === 'hc' && commandArguments[0] === 'wait' && askId !== undefined) {
      const record = await readAskRecord(root, askId);

      if (record?.route === 'hidden') {
        await writeAskRecord(root, { ...record, status: 'sent', answer: 'Use --quick.' });
      }

      failSecondRecordRead(askRecordPath(root, askId));

      throw waitFailure;
    }

    return hc.exec(command, commandArguments, options);
  };

  const result = await ask({ ...hc, exec }, root);

  expect(result).toMatchObject({ details: { status: 'ended', answer: 'Use --quick.' } });

  resetFileSystemFaults();

  expect(await statuses(root)).toEqual(['sent']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('reports the release failure and the launch error beside a cancelled lost reply', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      return succeededResult(JSON.stringify({ address: '', state: 'live' }));
    }

    return hc.exec(command, commandArguments, options);
  };

  armClaimReleaseFault();

  const failure = await ask({ ...hc, exec }, root).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  expect((failure as Error).message).toBe(
    `${askKeptClaimMessage(root)} The claim could not be released: The lock could not be truncated. hc run printed no usable terminal address`,
  );

  const cause = (failure as Error).cause;

  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toBe('hc run printed no usable terminal address');

  expect(await statuses(root)).toEqual(['failed']);

  expect((await details(root))[0]).toContain(
    'The claim could not be released: The lock could not be truncated.',
  );

  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('reports the release failure beside a gone child on a lost reply', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  useFakeStartProcess(cleanup, 'gone');
  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      await takeStartTicket(commandArguments);

      return { code: 0, killed: false, truncated: false, stdout: '', stderr: '' };
    }

    return hc.exec(command, commandArguments, options);
  };

  armClaimReleaseFault();

  const result = await ask({ ...hc, exec }, root);

  expect(result).toMatchObject({
    details: {
      status: 'needsOpen',
      reason: `${askKeptClaimMessage(root)} The claim could not be released: The lock could not be truncated.`,
    },
  });

  expect((await details(root))[0]).toContain(
    'The claim could not be released: The lock could not be truncated.',
  );

  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('keeps a timed-out ask running when the claim release fails after the child is gone', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  useFakeStartProcess(cleanup, 'gone');
  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      await takeStartTicket(commandArguments);

      return succeededResult(JSON.stringify({ address: 't-ask', state: 'live' }));
    }

    if (command === 'hc' && commandArguments[0] === 'wait') {
      return succeededResult(endedWait('t-ask', false));
    }

    return hc.exec(command, commandArguments, options);
  };

  armClaimReleaseFault();

  const result = await ask({ ...hc, exec }, root);

  expect(result).toMatchObject({
    details: {
      status: 'needsOpen',
      reason: `${askKeptClaimMessage(root)} The claim could not be released: The lock could not be truncated.`,
    },
  });

  expect(await statuses(root)).toEqual(['running']);
  expect(await details(root)).toEqual([askTimeoutReleaseDetail]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});
