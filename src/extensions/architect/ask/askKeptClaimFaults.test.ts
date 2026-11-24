import { afterEach, expect, it, vi } from 'vitest';

import { succeededResult } from '../../../../tests/execFake.js';
import { useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { askKeptClaimMessage } from './askHiddenRun.js';
import { ask, failFirstWait, startFake } from './fixtures/askHarness.js';

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

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'kill') {
      return succeededResult(JSON.stringify({ address: 't-ask', state: 'live' }));
    }

    return hc.exec(command, commandArguments, options);
  };

  faults.failClaimRelease = true;

  const failure = await ask(
    failFirstWait({ ...hc, exec }, new Error('The wait failed.')),
    root,
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(askKeptClaimMessage(root));

  expect((failure as Error).message).toContain(
    'The claim could not be released: The lock could not be truncated.',
  );
});
