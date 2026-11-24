import { afterEach, expect, it, vi } from 'vitest';

import { useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { openTool, requestFor } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { openArchitect, openKeptClaimMessage } from './open.js';

const faults = vi.hoisted(() => ({ failMarkerRead: false }));

const namedPath = (path: unknown, name: string): boolean =>
  typeof path === 'string' && path.includes(name);

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  const faultyReaddir = (async (
    ...readArguments: Parameters<typeof original.readdir>
  ): Promise<unknown> => {
    if (faults.failMarkerRead && namedPath(readArguments[0], '/start')) {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    }

    return original.readdir(...readArguments);
  }) as typeof original.readdir;

  return { ...original, readdir: faultyReaddir };
});

afterEach(() => {
  faults.failMarkerRead = false;
});

it('reports a marker read failure from the completion and keeps the claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root, undefined, undefined, { takeover: false });

  useFakeStartProcess(cleanup, 'running');
  await recordSession(root);

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    const result = await runtime.exec(command, commandArguments, options);

    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      faults.failMarkerRead = true;
    }

    return result;
  };

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(openKeptClaimMessage(root));

  expect((failure as Error).message).toContain(
    'The child adoption could not be read: EIO: i/o error',
  );

  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});
