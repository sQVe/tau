import { basename } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { argumentAfter } from '../../../../tests/execFake.js';
import {
  fakeStartProcessId,
  takeStartTicket,
  useFakeStartProcess,
} from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import {
  adoptClaim,
  openTool,
  requestFor,
  startedTerminalResult,
} from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { startDirectoryName } from '../startTicket/startTicket.js';
import { openArchitect, openKeptClaimMessage } from './open.js';

const faults = vi.hoisted(() => ({ failMarkerRead: false, failNextMarkerRead: false }));

const isStartDirectory = (path: unknown): boolean =>
  typeof path === 'string' && basename(path) === basename(startDirectoryName);

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  const faultyReaddir = (async (
    ...readArguments: Parameters<typeof original.readdir>
  ): Promise<unknown> => {
    const markerPath = isStartDirectory(readArguments[0]);
    const markerReadFailure = faults.failMarkerRead || faults.failNextMarkerRead;

    if (markerPath && markerReadFailure) {
      faults.failNextMarkerRead = false;

      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    }

    return original.readdir(...readArguments);
  }) as typeof original.readdir;

  return { ...original, readdir: faultyReaddir };
});

afterEach(() => {
  faults.failMarkerRead = false;
  faults.failNextMarkerRead = false;
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

it('returns the takeover result when the first marker read fails after the child adopted', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime, terminals } = openTool(root, undefined, undefined, { takeover: false });
  const processControl = useFakeStartProcess(cleanup, 'running');
  const sessionFile = await recordSession(root);

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      const holder = await readLiveLockHolder(architectLockPath(root));
      const argv = JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[];

      await takeStartTicket(argv);

      const release = await adoptClaim(root, holder?.token ?? '', 'adopted', fakeStartProcessId);

      if (release !== undefined) {
        cleanup(release);
      }

      faults.failNextMarkerRead = true;

      return startedTerminalResult(terminals, commandArguments);
    }

    return runtime.exec(command, commandArguments, options);
  };

  const result = await openArchitect(requestFor(root, config.location, { ...runtime, exec }));

  expect(result).toEqual({ status: 'resumed', sessionFile, model: 'a/architect' });
  expect(processControl.signals).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toMatchObject({ token: 'adopted' });
});

it('stops a running child and releases the claim after a one-time marker read failure', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime, terminals } = openTool(root, undefined, undefined, { takeover: false });
  const processControl = useFakeStartProcess(cleanup, 'running', true);

  await recordSession(root);

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      const argv = JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[];

      await takeStartTicket(argv);
      faults.failNextMarkerRead = true;

      return startedTerminalResult(terminals, commandArguments);
    }

    return runtime.exec(command, commandArguments, options);
  };

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  expect((failure as Error).message).toContain(
    'The child adoption could not be read: EIO: i/o error',
  );

  expect((failure as Error).cause).toMatchObject({ code: 'EIO' });
  expect((failure as Error).message).not.toContain(openKeptClaimMessage(root));

  expect(processControl.signals).toEqual(['SIGTERM']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});
