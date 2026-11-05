import { join } from 'node:path';

import { fauxProvider } from '@earendil-works/pi-ai';
import { expect, it, vi } from 'vitest';

import { createStartupGate } from '../src/extensions/inbox/startup.js';
import type { StartupGate } from '../src/extensions/inbox/startup.js';
import { createPiSession } from './piSession.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

it('keeps the gate closed while another extension still starts the session', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-inbox-startup-');
  const { promise: held, resolve: release } = Promise.withResolvers<undefined>();
  let blocking = false;
  let entered = false;
  let gate: StartupGate | undefined;

  const { session } = await createPiSession(onTestFinished, {
    cwd: directory,
    agentDirectory: join(directory, 'agent'),
    providers: [fauxProvider()],
    extensionFactories: [
      (pi) => {
        gate = createStartupGate(pi);
      },
      (pi) => {
        pi.on('session_start', () => {
          if (!blocking) {
            return undefined;
          }

          entered = true;

          return held;
        });
      },
    ],
  });

  await session.bindExtensions({});
  await gate?.whenReady();

  expect(gate?.isReady()).toBe(true);

  blocking = true;
  const binding = session.bindExtensions({});

  await vi.waitFor(() => {
    expect(entered).toBe(true);
  });

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  expect(gate?.isReady()).toBe(false);

  release(undefined);
  await binding;

  await gate?.whenReady();

  expect(gate?.isReady()).toBe(true);
});
