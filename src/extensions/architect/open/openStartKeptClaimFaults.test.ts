import { afterEach, expect, it, vi } from 'vitest';

import { failedResult } from '../../../../tests/execFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { openTool, requestFor, wrongModelReadbackExec } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { openArchitect, openKeptClaimMessage } from './open.js';

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

it('reports the claim release failure and keeps it for a later open', async ({
  onTestFinished,
}) => {
  const { root, config } = await setup(onTestFinished);
  const { runtime } = openTool(root, undefined, undefined, { takeover: false });

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      return failedResult('pane split failed');
    }

    return runtime.exec(command, commandArguments, options);
  };

  faults.failClaimRelease = true;

  const first: unknown = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec }),
  ).catch((error: unknown) => error);

  expect(first).toBeInstanceOf(Error);
  expect((first as Error).message).toContain(openKeptClaimMessage(root));

  expect((first as Error).message).toContain(
    'The claim could not be released: The lock could not be truncated.',
  );

  expect((first as Error).cause).toBeInstanceOf(Error);

  const later: unknown = await openArchitect(requestFor(root, config.location, runtime)).catch(
    (error: unknown) => error,
  );

  expect(later).toBeInstanceOf(Error);
  expect((later as Error).message).toBe((first as Error).message);
  expect((later as Error).cause).toBeInstanceOf(Error);
  expect(((later as Error).cause as Error).message).toBe(((first as Error).cause as Error).message);
});

it('keeps both the claim release failure and the readback failure', async ({ onTestFinished }) => {
  const { root, config } = await setup(onTestFinished);
  const { runtime } = openTool(root, undefined, undefined, { takeover: false });

  await recordSession(root);

  const exec = wrongModelReadbackExec(runtime, root);

  faults.failClaimRelease = true;

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  const message = (failure as Error).message;

  expect(message).toContain(openKeptClaimMessage(root));
  expect(message).toContain('The claim could not be released: The lock could not be truncated.');
  expect(message).toContain('morph/morph-dsv41flash-1017');
  expect(message).toContain('t-architect');
  expect((failure as Error).cause).toBeInstanceOf(Error);

  expect(((failure as Error).cause as Error).message).toContain('The claim could not be released');

  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();

  const later: unknown = await openArchitect(requestFor(root, config.location, runtime)).catch(
    (error: unknown) => error,
  );

  expect((later as Error).message).toBe(message);
});
