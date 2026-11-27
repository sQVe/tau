import { expect, it } from 'vitest';

import { succeededResult } from '../../../../tests/execFake.js';
import { useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { openTool, requestFor } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { openArchitect } from './open.js';

it('reports a started model that disagrees with the request after the child adopted the claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime, processControl } = openTool(root);
  let launched = false;

  await recordSession(root);

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    const result = await runtime.exec(command, commandArguments, options);

    launched ||= command === 'herdr-app';

    const readingTerminal =
      command === 'hc' &&
      commandArguments[0] === 'get' &&
      commandArguments.at(-1) === 't-architect';

    const readingStartedTerminal = launched && readingTerminal;

    if (readingStartedTerminal) {
      return succeededResult(
        JSON.stringify({
          address: 't-architect',
          state: 'live',
          foreground: {
            pid: 1,
            name: 'pi',
            argv: ['pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
            cwd: root,
          },
        }),
      );
    }

    return result;
  };

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  const message = (failure as Error).message;

  expect(message).toContain('morph/morph-dsv41flash-1017');
  expect(message).toContain('a/architect');
  expect(message).toContain('t-architect');
  expect(message).toContain('may still be running');
  expect(processControl?.signals).toEqual([]);
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

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    const readingStartedTerminal =
      command === 'hc' &&
      commandArguments[0] === 'get' &&
      commandArguments.at(-1) === 't-architect';

    if (readingStartedTerminal) {
      return succeededResult(
        JSON.stringify({
          address: 't-architect',
          state: 'live',
          foreground: {
            pid: 1,
            name: 'pi',
            argv: ['pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
            cwd: root,
          },
        }),
      );
    }

    return runtime.exec(command, commandArguments, options);
  };

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
