import * as filesystem from 'node:fs/promises';

import { expect, it, onTestFinished, vi } from 'vitest';

import { WorkerController } from './controller.js';
import { setup } from './fixtures/controllerFixture.js';
import { observeInstallLockRead } from './fixtures/installLockRead.js';
import { fakePackageRoot, writeFakePackage } from './fixtures/packageCache.js';
import type { WorkerPackageManager } from './packageInstall.js';

vi.mock(import('node:fs/promises'), { spy: true });

const actualFilesystem = await vi.importActual<typeof filesystem>('node:fs/promises');

const sharedControllers = async (cancelled: boolean) => {
  const started = Promise.withResolvers<undefined>();
  const contender = Promise.withResolvers<'waiting' | 'overlap'>();
  const release = Promise.withResolvers<undefined>();
  let running = 0;
  let mostRunning = 0;
  const windows: string[] = [];

  const manager = (workerLoadout: { agentDirectory: string }): WorkerPackageManager => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: async (sources) => {
      const source = sources[0]!;
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      windows.push(`start ${source}`);

      if (source === 'npm:first') {
        started.resolve(undefined);
        await release.promise;
      } else {
        contender.resolve('overlap');
      }

      writeFakePackage(workerLoadout.agentDirectory, source);
      windows.push(`end ${source}`);
      running -= 1;

      return {
        extensions: [
          {
            path: source,
            enabled: true,
            metadata: {
              source,
              scope: 'temporary',
              origin: 'package',
              packageRoot: fakePackageRoot(workerLoadout.agentDirectory, source),
            },
          },
        ],
        skills: [],
        prompts: [],
        themes: [],
      };
    },
  });

  const fixture = setup(onTestFinished, 0, undefined, manager);
  const cancel = new AbortController();

  const firstInput = {
    ...fixture.input,
    loadout: { ...fixture.input.loadout, packages: ['npm:first'] },
  };

  const first = fixture.controller.launch(firstInput, cancel.signal);
  const firstOutcome = first.catch((error: unknown) => error);

  await started.promise;

  if (cancelled) {
    cancel.abort();
    await expect(firstOutcome).resolves.toMatchObject({ name: 'InstallStoppedError' });
    fixture.controller.close();
  }

  const observedRead = observeInstallLockRead(
    actualFilesystem.readFile,
    fixture.input.loadout.agentDirectory,
    () => {
      contender.resolve('waiting');
    },
  );

  vi.spyOn(filesystem, 'readFile').mockImplementation(observedRead);

  const secondController = new WorkerController(
    fixture.directory,
    fixture.client,
    () => {},
    manager,
  );

  onTestFinished(() => {
    secondController.close();
  });

  const secondInput = {
    ...fixture.input,
    loadout: { ...fixture.input.loadout, packages: ['npm:second'] },
  };

  const second = secondController.launch(secondInput);

  try {
    expect(await contender.promise).toBe('waiting');
  } finally {
    release.resolve(undefined);
    await firstOutcome;
    await second;
  }

  const result = await second;

  expect(result.failure).toBeUndefined();

  expect(windows).toEqual([
    'start npm:first',
    'end npm:first',
    'start npm:second',
    'end npm:second',
  ]);

  return mostRunning;
};

it('serializes installs from separate controllers sharing an agent directory', async () => {
  expect(await sharedControllers(false)).toBe(1);
});

it('keeps an abandoned install locked when a new controller starts', async () => {
  expect(await sharedControllers(true)).toBe(1);
});
