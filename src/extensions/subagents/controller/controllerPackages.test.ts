import { readdirSync } from 'node:fs';

import { expect, it, vi } from 'vitest';

import { readTask } from '../records.js';
import { completed, savedFiles, setup } from './fixtures/controllerFixture.js';
import type { WorkerPackageManager } from './packageInstall.js';

vi.mock(import('node:fs'), { spy: true });

const installedPackages = (sources: string[]) => ({
  extensions: sources.map((path) => ({
    path,
    enabled: true,
    metadata: { source: path, scope: 'temporary' as const, origin: 'package' as const },
  })),
  skills: [],
  prompts: [],
  themes: [],
});

const packageSettings = (configured: string[]) => {
  const installs: string[][] = [];

  const manager = (): WorkerPackageManager => ({
    listConfiguredPackages: () =>
      configured.map((source) => ({ source, scope: 'user' as const, filtered: false })),
    resolveExtensionSources: (sources) => {
      installs.push(sources);

      if (sources.includes('npm:broken')) {
        return Promise.reject(new Error('npm install failed'));
      }

      return Promise.resolve(installedPackages(sources));
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
  expect(command.slice(-2)).toEqual(['-e', 'npm:pi-codex-image-gen']);
  expect(settings.installs).toEqual([['npm:pi-codex-image-gen']]);
  expect(readTask(launched.directory).loadout.packages).toEqual(packages);
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
        fixture.fake.state.stopped = true;
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

  expect(launchedCommand(fixture.calls).slice(-2)).toEqual(['-e', 'npm:pi-agent-browser-native']);

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

  const manager = (): WorkerPackageManager => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: async (sources) => {
      installing.resolve(undefined);
      await release.promise;

      return installedPackages(sources);
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

  const manager = (): WorkerPackageManager => ({
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

      return Promise.resolve(installedPackages(sources));
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
  const second = launch('npm:second', cancelSecond);

  await firstStarted.promise;

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
