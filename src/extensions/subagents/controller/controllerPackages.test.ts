import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished as afterTest, vi } from 'vitest';

import { readTask } from '../records.js';
import { WorkerController } from './controller.js';
import { completed, savedFiles, setup } from './fixtures/controllerFixture.js';
import {
  fakePackageRoot,
  fakePackageSnapshot,
  snapshotDirectory,
  writeFakePackage,
} from './fixtures/packageCache.js';
import type { WorkerPackageManager } from './packageInstall.js';

vi.mock(import('node:fs'), { spy: true });
vi.mock(import('node:fs/promises'), { spy: true });

const installedPackages = (agentDirectory: string, sources: string[]) => ({
  extensions: sources.map((source) => {
    writeFakePackage(agentDirectory, source);

    return {
      path: source,
      enabled: true,
      metadata: {
        source,
        scope: 'temporary' as const,
        origin: 'package' as const,
        packageRoot: fakePackageRoot(agentDirectory, source),
      },
    };
  }),
  skills: [],
  prompts: [],
  themes: [],
});

const packageSettings = (configured: string[]) => {
  const installs: string[][] = [];

  const manager = (workerLoadout: { agentDirectory: string }): WorkerPackageManager => ({
    listConfiguredPackages: () =>
      configured.map((source) => ({ source, scope: 'user' as const, filtered: false })),
    resolveExtensionSources: (sources) => {
      installs.push(sources);

      if (sources.includes('npm:broken')) {
        return Promise.reject(new Error('npm install failed'));
      }

      return Promise.resolve(installedPackages(workerLoadout.agentDirectory, sources));
    },
  });

  return { configured, installs, manager };
};

const launchedCommand = (calls: string[][]): string[] => {
  const launches = calls.filter((call) => call[0] === 'layout');
  const { root } = JSON.parse(launches.at(-1)?.[2] ?? '') as { root: { command: string[] } };

  return root.command;
};

it('loads profile packages with -e after the worker guards, skipping those settings load', async ({
  onTestFinished,
}) => {
  const settings = packageSettings(['npm:pi-agent-browser-native']);
  const { controller, input, calls } = setup(onTestFinished, 0, undefined, settings.manager);
  const packages = ['npm:pi-agent-browser-native@0.8.2', 'npm:pi-codex-image-gen'];
  const launched = await controller.launch({ ...input, loadout: { ...input.loadout, packages } });
  const command = launchedCommand(calls);

  expect(launched.failure).toBeUndefined();
  expect(command.at(-3)).toMatch(/workerExtension\.ts$/);

  expect(command.slice(-2)).toEqual([
    '-e',
    fakePackageSnapshot(input.loadout.agentDirectory, launched.taskId, 'npm:pi-codex-image-gen'),
  ]);

  expect(settings.installs).toEqual([['npm:pi-codex-image-gen']]);
  expect(readTask(launched.directory).loadout.packages).toEqual(packages);
});

it('loads a remote profile package from the snapshot the parent installed', async ({
  onTestFinished,
}) => {
  const source = 'npm:pi-codex-image-gen';

  const manager = (workerLoadout: { agentDirectory: string }): WorkerPackageManager => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: (sources) =>
      Promise.resolve(installedPackages(workerLoadout.agentDirectory, sources)),
  });

  const { controller, input, calls } = setup(onTestFinished, 0, undefined, manager);
  const loadout = { ...input.loadout, packages: [source] };
  const launched = await controller.launch({ ...input, loadout });
  const command = launchedCommand(calls);

  expect(launched.failure).toBeUndefined();

  expect(command.slice(-2)).toEqual([
    '-e',
    fakePackageSnapshot(input.loadout.agentDirectory, launched.taskId, source),
  ]);

  expect(command).not.toContain(source);
});

it('keeps the first worker package content when a later launch replaces the shared cache', async ({
  onTestFinished,
}) => {
  const settings = packageSettings([]);
  const { controller, input, calls } = setup(onTestFinished, 0, undefined, settings.manager);

  const first = await controller.launch({
    ...input,
    loadout: { ...input.loadout, packages: ['npm:shared@1'] },
  });

  const firstPackage = launchedCommand(calls).at(-1)!;

  const second = await controller.launch({
    ...input,
    loadout: { ...input.loadout, packages: ['npm:shared@2'] },
  });

  const secondPackage = launchedCommand(calls).at(-1)!;
  const cacheRoot = fakePackageRoot(input.loadout.agentDirectory, 'npm:shared@1');

  expect(first.failure).toBeUndefined();
  expect(second.failure).toBeUndefined();
  expect(readFileSync(join(cacheRoot, 'content.txt'), 'utf8')).toBe('npm:shared@2');
  expect(readFileSync(join(firstPackage, 'content.txt'), 'utf8')).toBe('npm:shared@1');
  expect(readFileSync(join(secondPackage, 'content.txt'), 'utf8')).toBe('npm:shared@2');
});

it('refuses a launch whose profile package fails to install before it opens a pane', async ({
  onTestFinished,
}) => {
  const settings = packageSettings([]);

  const { controller, input, calls, directory } = setup(
    onTestFinished,
    0,
    undefined,
    settings.manager,
  );

  const saved = readdirSync(directory);
  const loadout = { ...input.loadout, packages: ['npm:broken', 'npm:later'] };

  await expect(controller.launch({ ...input, loadout })).rejects.toThrow(
    'Worker profile package npm:broken failed to install',
  );

  expect(settings.installs).toEqual([['npm:broken']]);
  expect(calls.filter((call) => call[0] === 'layout')).toEqual([]);
  expect(readdirSync(directory)).toEqual(saved);
});

it('names the -e packages when the worker exits before readiness', async ({ onTestFinished }) => {
  let inspections = 0;
  const settings = packageSettings(['npm:pi-agent-browser-native']);

  const fixture = setup(
    onTestFinished,
    -1,
    async (argumentsList) => {
      // Pi exits at startup, and herdr removes its pane.
      if (argumentsList[1] === 'process-info' && ++inspections > 1) {
        fixture.fake.exit(fixture.fake.workers()[0]!.terminalId);
      }

      return '';
    },
    settings.manager,
  );

  const packages = ['npm:pi-agent-browser-native', 'npm:pi-codex-image-gen'];
  const loadout = { ...fixture.input.loadout, packages };
  const status = await fixture.controller.launch({ ...fixture.input, loadout });

  expect(status).toMatchObject({ outcome: 'failure', state: 'stopped' });
  expect(status.failure).toContain('exited before readiness');
  expect(status.failure).toContain('pi -e <source>');
  expect(status.failure).toContain('npm:pi-codex-image-gen');
  expect(status.failure).not.toContain('npm:pi-agent-browser-native');
});

it('decides the -e packages again when a follow-up starts after settings change', async () => {
  const settings = packageSettings([]);
  const packages = ['npm:pi-agent-browser-native'];
  const fixture = await completed(undefined, { manager: settings.manager, sources: packages });

  expect(launchedCommand(fixture.calls).slice(-2)).toEqual([
    '-e',
    fakePackageSnapshot(
      fixture.source.loadout.agentDirectory,
      fixture.source.taskId,
      'npm:pi-agent-browser-native',
    ),
  ]);

  settings.configured.push('npm:pi-agent-browser-native');
  fixture.calls.length = 0;
  const next = await fixture.controller.followUp(fixture.input, fixture.context);
  const listings = fixture.calls.filter((call) => call[0] === 'agent' && call[1] === 'list');

  expect(next.failure).toBeUndefined();
  // Without an install, nothing waited, so the first listing still holds.
  expect(listings).toHaveLength(1);
  expect(launchedCommand(fixture.calls).at(-1)).toMatch(/workerExtension\.ts$/);
  expect(readTask(next.directory).loadout.packages).toEqual(packages);
});

it('stops waiting for a pending package install when the launch is cancelled', async ({
  onTestFinished,
}) => {
  const installing = Promise.withResolvers<undefined>();

  const manager = (): WorkerPackageManager => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: () => {
      installing.resolve(undefined);

      // A stalled npm install.
      return new Promise(() => {});
    },
  });

  const { controller, input, calls, directory } = setup(onTestFinished, 0, undefined, manager);
  const saved = readdirSync(directory);
  const cancel = new AbortController();
  const loadout = { ...input.loadout, packages: ['npm:slow'] };
  const launch = controller.launch({ ...input, loadout }, cancel.signal);

  await installing.promise;
  cancel.abort();

  await expect(launch).rejects.toThrow('Worker profile package npm:slow install was cancelled.');
  expect(calls.filter((call) => call[0] === 'layout')).toEqual([]);
  expect(readdirSync(directory)).toEqual(saved);
});

it('refuses a launch at capacity before it installs profile packages', async ({
  onTestFinished,
}) => {
  const settings = packageSettings([]);
  const { controller, input } = setup(onTestFinished, 0, undefined, settings.manager, 1);

  await controller.launch(input);
  const loadout = { ...input.loadout, packages: ['npm:pi-codex-image-gen'] };

  await expect(controller.launch({ ...input, loadout })).rejects.toThrow('Worker capacity full');
  expect(settings.installs).toEqual([]);
});

it('refuses a launch whose slot another launch took during its package install', async ({
  onTestFinished,
}) => {
  const installing = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();

  const manager = (workerLoadout: { agentDirectory: string }): WorkerPackageManager => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: async (sources) => {
      installing.resolve(undefined);
      await release.promise;

      return installedPackages(workerLoadout.agentDirectory, sources);
    },
  });

  const { controller, input, directory } = setup(onTestFinished, 0, undefined, manager, 1);
  const loadout = { ...input.loadout, packages: ['npm:slow'] };
  const waiting = controller.launch({ ...input, loadout });

  await installing.promise;
  const taken = await controller.launch(input);
  const saved = readdirSync(directory);

  release.resolve(undefined);

  await expect(waiting).rejects.toThrow('Worker capacity full');
  expect(taken.failure).toBeUndefined();
  expect(readdirSync(directory)).toEqual(saved);
});

const stalledInstall = (): WorkerPackageManager => ({
  listConfiguredPackages: () => [],
  resolveExtensionSources: () => new Promise(() => {}),
});

it('names the package whose install outlasts the launch budget', async ({ onTestFinished }) => {
  const { controller, input, directory } = setup(onTestFinished, 0, undefined, stalledInstall);
  const saved = readdirSync(directory);
  const loadout = { ...input.loadout, packages: ['npm:slow'] };

  // AbortSignal.timeout ignores fake timers, so this test waits in real time.
  await expect(controller.launch({ ...input, loadout, timeout: 200 })).rejects.toThrow(
    'Worker profile package npm:slow install ran out of launch time.',
  );

  expect(readdirSync(directory)).toEqual(saved);
});

it('refuses a follow-up whose native session gained a live writer during its install', async () => {
  let live: unknown[] = [];
  let following = false;

  const manager = (workerLoadout: { agentDirectory: string }): WorkerPackageManager => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: (sources) => {
      // The user resumes the saved session by hand while npm runs.
      if (following) {
        live = [
          {
            pane_id: 'manual',
            name: 'manual-pi',
            agent_session: { kind: 'path', value: fixture.source.nativeSessionFile },
          },
        ];
      }

      return Promise.resolve(installedPackages(workerLoadout.agentDirectory, sources));
    },
  });

  const fixture = await completed(
    async (argumentsList) =>
      argumentsList[0] === 'agent' && argumentsList[1] === 'list'
        ? JSON.stringify({ result: { type: 'agent_list', agents: live } })
        : '',
    { manager, sources: ['npm:pi-agent-browser-native'] },
  );

  const saved = savedFiles(fixture.directory);
  fixture.calls.length = 0;
  following = true;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    'already live',
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);

  expect(fixture.calls).toEqual([
    ['agent', 'list'],
    ['agent', 'list'],
  ]);
});

it('never runs two profile package installs at once across parallel launches', async ({
  onTestFinished,
}) => {
  const started: string[] = [];
  const firstStarted = Promise.withResolvers<undefined>();
  let queued = 0;

  const manager = (): WorkerPackageManager => ({
    // Each launch reads settings right before it joins the install queue.
    listConfiguredPackages: () => {
      queued += 1;

      return [];
    },
    resolveExtensionSources: (sources) => {
      started.push(...sources);
      firstStarted.resolve(undefined);

      // A stalled npm install.
      return new Promise(() => {});
    },
  });

  const { controller, input, directory } = setup(onTestFinished, 0, undefined, manager);
  const saved = readdirSync(directory);
  const cancelFirst = new AbortController();
  const cancelSecond = new AbortController();

  const launch = (source: string, cancel: AbortController) =>
    controller.launch(
      { ...input, loadout: { ...input.loadout, packages: [source] } },
      cancel.signal,
    );

  const first = launch('npm:first', cancelFirst);

  await firstStarted.promise;
  const second = launch('npm:second', cancelSecond);

  await vi.waitFor(() => {
    expect(queued).toBe(2);
  });

  // Run every pending step of the second launch while the first install still runs.
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  expect(started).toEqual(['npm:first']);

  cancelSecond.abort();
  await expect(second).rejects.toThrow('npm:second install was cancelled');
  cancelFirst.abort();
  await expect(first).rejects.toThrow('npm:first install was cancelled');
  expect(started).toEqual(['npm:first']);
  expect(readdirSync(directory)).toEqual(saved);
});

it('refuses a launch when copying its package fails and removes its snapshot', async ({
  onTestFinished,
}) => {
  const source = 'npm:missing';

  const manager = (workerLoadout: { agentDirectory: string }): WorkerPackageManager => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: () =>
      Promise.resolve({
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
      }),
  });

  const { controller, input, calls, directory } = setup(onTestFinished, 0, undefined, manager);
  const saved = savedFiles(directory);

  await expect(
    controller.launch({
      ...input,
      loadout: { ...input.loadout, packages: [source] },
    }),
  ).rejects.toThrow(/npm:missing.*failed to snapshot/);

  expect(calls.some((call) => call[0] === 'layout')).toBe(false);
  expect(savedFiles(directory)).toEqual(saved);
  expect(readdirSync(join(input.loadout.agentDirectory, 'tmp', 'tau-worker-packages'))).toEqual([]);
});

it('removes the launch package snapshot after its worker stops', async ({ onTestFinished }) => {
  const settings = packageSettings([]);
  const { controller, input } = setup(onTestFinished, 0, undefined, settings.manager);
  const source = 'npm:pi-codex-image-gen';

  const launched = await controller.launch({
    ...input,
    loadout: { ...input.loadout, packages: [source] },
  });

  const snapshot = snapshotDirectory(input.loadout.agentDirectory, launched.taskId);

  expect(launched.failure).toBeUndefined();
  expect(existsSync(snapshot)).toBe(true);

  await controller.cancel(launched.taskId, input.parentSessionId);

  expect(existsSync(snapshot)).toBe(false);
});

it('keeps the package snapshot when the worker stop is unconfirmed', async ({ onTestFinished }) => {
  const settings = packageSettings([]);
  let cleaning = false;

  const { controller, input } = setup(
    onTestFinished,
    0,
    async () => {
      if (cleaning) {
        throw new Error('Herdr unavailable');
      }

      return '';
    },
    settings.manager,
  );

  const launched = await controller.launch({
    ...input,
    loadout: { ...input.loadout, packages: ['npm:shared'] },
  });

  expect(launched.failure).toBeUndefined();
  cleaning = true;
  await controller.cancel(launched.taskId, input.parentSessionId);

  expect(existsSync(snapshotDirectory(input.loadout.agentDirectory, launched.taskId))).toBe(true);
});

it('removes the package snapshot when a saved task is stopped by a new controller', async ({
  onTestFinished,
}) => {
  const settings = packageSettings([]);

  const { controller, input, client, directory } = setup(
    onTestFinished,
    0,
    undefined,
    settings.manager,
  );

  const launched = await controller.launch({
    ...input,
    loadout: { ...input.loadout, packages: ['npm:shared'] },
  });

  const snapshot = snapshotDirectory(input.loadout.agentDirectory, launched.taskId);

  expect(launched.failure).toBeUndefined();
  expect(existsSync(snapshot)).toBe(true);
  controller.close();

  const recovered = new WorkerController(directory, client);

  onTestFinished(() => {
    recovered.close();
  });

  await recovered.cancel(launched.taskId, input.parentSessionId);

  expect(existsSync(snapshot)).toBe(false);
});

it.each(['saved agent directory', 'trusted snapshot root'])(
  'refuses snapshot cleanup through a redirected %s',
  async (redirected) => {
    const settings = packageSettings([]);

    const { controller, input, client, directory } = setup(
      afterTest,
      0,
      undefined,
      settings.manager,
    );

    const launched = await controller.launch({
      ...input,
      loadout: { ...input.loadout, packages: ['npm:shared'] },
    });

    expect(launched.failure).toBeUndefined();
    controller.close();
    const outsideRoot = join(directory, 'unrelated');
    const victim = join(outsideRoot, launched.taskId);

    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'keep.txt'), 'unrelated data');
    let originalSnapshot = snapshotDirectory(input.loadout.agentDirectory, launched.taskId);

    if (redirected === 'saved agent directory') {
      const redirectedAgent = join(directory, 'redirected-agent');

      mkdirSync(join(redirectedAgent, 'tmp'), { recursive: true });
      symlinkSync(outsideRoot, join(redirectedAgent, 'tmp', 'tau-worker-packages'));
      const task = readTask(launched.directory);

      writeFileSync(
        join(launched.directory, 'task.json'),
        JSON.stringify({
          ...task,
          loadout: { ...task.loadout, agentDirectory: redirectedAgent },
        }),
      );
    } else {
      const root = join(input.loadout.agentDirectory, 'tmp', 'tau-worker-packages');

      renameSync(root, `${root}-original`);
      originalSnapshot = join(`${root}-original`, launched.taskId);
      symlinkSync(outsideRoot, root);
    }

    const recovered = new WorkerController(directory, client);

    afterTest(() => {
      recovered.close();
    });

    await expect(recovered.cancel(launched.taskId, input.parentSessionId)).rejects.toThrow(
      'snapshot',
    );

    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('unrelated data');
    expect(existsSync(originalSnapshot)).toBe(true);
  },
);

it('refuses recovered cleanup when the saved task ID names another task', async ({
  onTestFinished,
}) => {
  const settings = packageSettings([]);

  const { controller, input, client, directory, calls } = setup(
    onTestFinished,
    0,
    undefined,
    settings.manager,
  );

  const loadout = { ...input.loadout, packages: ['npm:shared'] };
  const first = await controller.launch({ ...input, loadout });
  const second = await controller.launch({ ...input, loadout });

  expect(first.failure).toBeUndefined();
  expect(second.failure).toBeUndefined();
  controller.close();

  const task = readTask(first.directory);

  writeFileSync(
    join(first.directory, 'task.json'),
    JSON.stringify({ ...task, taskId: second.taskId }),
  );

  const saved = savedFiles(directory);
  const previousCalls = calls.length;
  const recovered = new WorkerController(directory, client);

  onTestFinished(() => {
    recovered.close();
  });

  await expect(recovered.cancel(first.taskId, input.parentSessionId)).rejects.toThrow(
    'task ID does not match',
  );

  await expect(async () => recovered.status(first.taskId, input.parentSessionId)).rejects.toThrow(
    'task ID does not match',
  );

  expect(existsSync(snapshotDirectory(input.loadout.agentDirectory, first.taskId))).toBe(true);
  expect(existsSync(snapshotDirectory(input.loadout.agentDirectory, second.taskId))).toBe(true);
  expect(savedFiles(directory)).toEqual(saved);
  expect(calls.slice(previousCalls)).toEqual([]);
});

it('reports both launch and snapshot removal errors while preserving the launch cause', async () => {
  const settings = packageSettings([]);
  const launchError = new Error('Admission listing failed');
  let following = false;
  let listings = 0;

  const fixture = await completed(
    async (argumentsList) => {
      if (following && argumentsList[0] === 'agent' && argumentsList[1] === 'list') {
        listings += 1;

        if (listings === 2) {
          throw launchError;
        }
      }

      return '';
    },
    { manager: settings.manager, sources: ['npm:shared'] },
  );

  const snapshots = join(fixture.source.loadout.agentDirectory, 'tmp', 'tau-worker-packages');
  const before = readdirSync(snapshots);
  const { rm: remove } = await vi.importActual<typeof filesystem>('node:fs/promises');

  vi.spyOn(filesystem, 'rm').mockImplementation(async (path, options) => {
    if (typeof path === 'string' && path.startsWith(snapshots)) {
      throw new Error('snapshot removal denied');
    }

    return remove(path, options);
  });

  following = true;

  const failure = await fixture.controller
    .followUp(fixture.input, fixture.context)
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('Admission listing failed');
  expect((failure as Error).message).toContain('snapshot removal denied');
  expect((failure as Error).cause).toBe(launchError);
  expect(readdirSync(snapshots)).toHaveLength(before.length + 1);
});

it('removes the launch package snapshot when the launch fails before starting a worker', async () => {
  const source = 'npm:pi-agent-browser-native';
  let live: unknown[] = [];
  let following = false;
  let snapshotsDuringInstall: string[] = [];

  const manager = (workerLoadout: { agentDirectory: string }): WorkerPackageManager => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: (sources) => {
      if (following) {
        live = [
          {
            pane_id: 'manual',
            name: 'manual-pi',
            agent_session: { kind: 'path', value: fixture.source.nativeSessionFile },
          },
        ];
      }

      return Promise.resolve(installedPackages(workerLoadout.agentDirectory, sources));
    },
  });

  const fixture = await completed(
    async (argumentsList) => {
      if (argumentsList[0] === 'agent' && argumentsList[1] === 'list' && following) {
        const root = join(fixture.source.loadout.agentDirectory, 'tmp', 'tau-worker-packages');

        snapshotsDuringInstall = existsSync(root) ? readdirSync(root) : [];

        return JSON.stringify({ result: { type: 'agent_list', agents: live } });
      }

      return '';
    },
    { manager, sources: [source] },
  );

  const snapshots = join(fixture.source.loadout.agentDirectory, 'tmp', 'tau-worker-packages');
  const before = existsSync(snapshots) ? readdirSync(snapshots) : [];

  following = true;

  const failure = fixture.controller.followUp(fixture.input, fixture.context);

  await expect(failure).rejects.toThrow('already live');
  await expect(failure).rejects.not.toThrow('failed to remove');

  expect(snapshotsDuringInstall).toHaveLength(before.length + 1);
  expect(existsSync(snapshots) ? readdirSync(snapshots) : []).toEqual(before);
});
