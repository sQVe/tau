import { expect, it } from 'vitest';

import { useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { StartedTabError } from '../../../piStart/startedTab.js';
import { openTool, requestFor, wrongModelReadbackExec } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { openArchitect, openKeptClaimMessage } from './open.js';

it('reports a started model that disagrees with the request after the child adopted the claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime, processControl } = openTool(root);

  if (processControl === undefined) {
    throw new Error('the default takeover provided no process control');
  }

  await recordSession(root);

  const exec = wrongModelReadbackExec(runtime, root);

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  const message = (failure as Error).message;

  expect(message).toContain('morph/morph-dsv41flash-1017');
  expect(message).toContain('a/architect');
  expect(message).toContain('t-architect');
  expect(message).toContain('may still be running');
  expect(processControl.signals).toEqual([]);
  // The adopted child keeps its own claim, so a retry reports the running terminal instead of
  // starting a second architect.
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('reports a started model that disagrees with the request and stops the child', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root, undefined, undefined, { takeover: false });
  const processControl = useFakeStartProcess(cleanup, 'running', true);

  await recordSession(root);

  const exec = wrongModelReadbackExec(runtime, root);

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  const message = (failure as Error).message;

  expect(message).toContain('morph/morph-dsv41flash-1017');
  expect(message).toContain('a/architect');
  expect(message).toContain('t-architect');
  expect(processControl.signals).toEqual(['SIGTERM']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('keeps the readback failure in the kept-claim message', async ({ onTestFinished: cleanup }) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root, undefined, undefined, { takeover: false });

  useFakeStartProcess(cleanup, 'unknown');

  await recordSession(root);

  const exec = wrongModelReadbackExec(runtime, root);

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  const message = (failure as Error).message;

  expect(message).toContain(openKeptClaimMessage(root));
  expect(message).toContain('morph/morph-dsv41flash-1017');
  expect(message).toContain('t-architect');
  expect((failure as Error).cause).toBeInstanceOf(StartedTabError);
});
