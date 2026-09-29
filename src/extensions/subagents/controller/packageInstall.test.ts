import { join } from 'node:path';

import type { ResolvedPaths } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { fixtureLoadout } from '../fixtures/loadout.js';
import { InstallQueue, installWorkerPackages } from './packageInstall.js';
import type { WorkerPackageManager } from './packageInstall.js';

const resolved = (extension: string): ResolvedPaths => ({
  extensions: [
    {
      path: extension,
      enabled: true,
      metadata: { source: extension, scope: 'temporary', origin: 'package' },
    },
  ],
  skills: [],
  prompts: [],
  themes: [],
});

const fakeManager = (
  configured: { source: string; scope: 'user' | 'project' }[],
  failing = new Set<string>(),
) => {
  const installs: { sources: string[]; temporary: boolean | undefined }[] = [];

  const manager: WorkerPackageManager = {
    listConfiguredPackages: () => configured.map((entry) => ({ ...entry, filtered: false })),
    resolveExtensionSources: (sources, options) => {
      installs.push({ sources, temporary: options?.temporary });
      const source = sources[0] ?? '';

      if (failing.has(source)) {
        return Promise.reject(new Error('npm install failed'));
      }

      return Promise.resolve(
        failing.has(`empty:${source}`) ? { ...resolved(''), extensions: [] } : resolved(source),
      );
    },
  };

  return { manager, installs };
};

const signal = new AbortController().signal;

const loadout = { ...fixtureLoadout('/work'), agentDirectory: '/work/agent' };

it('installs each profile package that settings do not already load, one at a time', async () => {
  const { manager, installs } = fakeManager([
    { source: 'npm:pi-agent-browser-native@0.8.2', scope: 'user' },
    { source: '../extensions/shared', scope: 'project' },
  ]);

  const sources = await installWorkerPackages(
    {
      ...loadout,
      packages: [
        'npm:pi-agent-browser-native',
        'npm:pi-codex-image-gen',
        'extensions/shared',
        './probe',
      ],
    },
    () => manager,
    new InstallQueue(),
    signal,
  );

  expect(sources).toEqual(['npm:pi-codex-image-gen', join('/work', 'probe')]);

  expect(installs).toEqual([
    { sources: ['npm:pi-codex-image-gen'], temporary: true },
    { sources: [join('/work', 'probe')], temporary: true },
  ]);
});

it('skips a local profile package that user settings name relative to the agent directory', async () => {
  const { manager, installs } = fakeManager([{ source: './probe', scope: 'user' }]);

  const sources = await installWorkerPackages(
    { ...loadout, packages: ['agent/probe'] },
    () => manager,
    new InstallQueue(),
    signal,
  );

  expect(sources).toEqual([]);
  expect(installs).toEqual([]);
});

const pendingManager = (): WorkerPackageManager => ({
  listConfiguredPackages: () => [],
  resolveExtensionSources: () => new Promise(() => undefined),
});

it.each([
  { reason: new DOMException('Launch cancelled.', 'AbortError'), stop: 'was cancelled' },
  { reason: new DOMException('Budget spent.', 'TimeoutError'), stop: 'ran out of launch time' },
])('names the package when its install $stop', async ({ reason, stop }) => {
  const abort = new AbortController();
  const packages = { ...loadout, packages: ['npm:slow', 'npm:later'] };

  const installing = installWorkerPackages(
    packages,
    pendingManager,
    new InstallQueue(),
    abort.signal,
  );

  abort.abort(reason);

  await expect(installing).rejects.toThrow(`Worker profile package npm:slow install ${stop}.`);
});

it('reads a file URL package as the local path it names', async () => {
  const { manager, installs } = fakeManager([{ source: 'file:///work/shared', scope: 'user' }]);

  const sources = await installWorkerPackages(
    { ...loadout, packages: ['/work/shared', 'file:///work/probe'] },
    () => manager,
    new InstallQueue(),
    signal,
  );

  expect(sources).toEqual(['/work/probe']);
  expect(installs.map((install) => install.sources)).toEqual([['/work/probe']]);
});

it('stops at the first package that fails to install and names it', async () => {
  const { manager, installs } = fakeManager([], new Set(['npm:broken']));

  await expect(
    installWorkerPackages(
      { ...loadout, packages: ['npm:broken', 'npm:later'] },
      () => manager,
      new InstallQueue(),
      signal,
    ),
  ).rejects.toThrow('Worker profile package npm:broken failed to install: npm install failed');

  expect(installs.map(({ sources }) => sources)).toEqual([['npm:broken']]);
});

it('refuses a package that installs no Pi resources and names it', async () => {
  const { manager } = fakeManager([], new Set(['empty:npm:offline']));

  await expect(
    installWorkerPackages(
      { ...loadout, packages: ['npm:offline'] },
      () => manager,
      new InstallQueue(),
      signal,
    ),
  ).rejects.toThrow('Worker profile package npm:offline');
});

const settingsRead = (): WorkerPackageManager => {
  throw new Error('settings read');
};

it('reads no settings for a profile without packages', async () => {
  await expect(
    installWorkerPackages(loadout, settingsRead, new InstallQueue(), signal),
  ).resolves.toEqual([]);
});

// Installs settle only when the test says, and record how many run at once.
const heldInstalls = () => {
  const started: string[] = [];
  const pending = new Map<string, PromiseWithResolvers<ResolvedPaths>>();
  let running = 0;
  let mostRunning = 0;
  const startedSignal = new EventTarget();

  const manager = (): WorkerPackageManager => ({
    listConfiguredPackages: () => [],
    resolveExtensionSources: async (sources) => {
      const source = sources[0] ?? '';
      const install = Promise.withResolvers<ResolvedPaths>();

      pending.set(source, install);
      started.push(source);
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      startedSignal.dispatchEvent(new Event(source));

      try {
        return await install.promise;
      } finally {
        running -= 1;
      }
    },
  });

  const whenStarted = (source: string) =>
    started.includes(source)
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          startedSignal.addEventListener(source, () => {
            resolve();
          });
        });

  const settle = (source: string, outcome: 'installed' | 'failed') => {
    const install = pending.get(source);

    if (outcome === 'installed') {
      install?.resolve(resolved(source));
    } else {
      install?.reject(new Error('npm install failed'));
    }
  };

  return { manager, started, whenStarted, settle, mostRunning: () => mostRunning };
};

const launchPackage = (
  installs: ReturnType<typeof heldInstalls>,
  queue: InstallQueue,
  source: string,
  launchSignal = signal,
) =>
  installWorkerPackages({ ...loadout, packages: [source] }, installs.manager, queue, launchSignal);

it('lets a queued launch stop waiting without blocking the launch behind it', async () => {
  const installs = heldInstalls();
  const queue = new InstallQueue();
  const cancel = new AbortController();

  const first = launchPackage(installs, queue, 'npm:first');
  const second = launchPackage(installs, queue, 'npm:second', cancel.signal);
  const third = launchPackage(installs, queue, 'npm:third');

  await installs.whenStarted('npm:first');
  cancel.abort();

  await expect(second).rejects.toThrow('Worker profile package npm:second install was cancelled.');
  expect(installs.started).toEqual(['npm:first']);

  installs.settle('npm:first', 'installed');
  await installs.whenStarted('npm:third');
  installs.settle('npm:third', 'installed');

  await expect(first).resolves.toEqual(['npm:first']);
  await expect(third).resolves.toEqual(['npm:third']);
  expect(installs.started).toEqual(['npm:first', 'npm:third']);
  expect(installs.mostRunning()).toBe(1);
});

it('waits for an abandoned install to settle before the next one starts', async () => {
  const installs = heldInstalls();
  const queue = new InstallQueue();
  const cancel = new AbortController();

  const first = launchPackage(installs, queue, 'npm:first', cancel.signal);
  const second = launchPackage(installs, queue, 'npm:second');

  await installs.whenStarted('npm:first');
  cancel.abort();

  await expect(first).rejects.toThrow('npm:first install was cancelled');
  expect(installs.started).toEqual(['npm:first']);

  installs.settle('npm:first', 'installed');
  await installs.whenStarted('npm:second');
  installs.settle('npm:second', 'installed');

  await expect(second).resolves.toEqual(['npm:second']);
  expect(installs.mostRunning()).toBe(1);
});

it('starts the next queued install after an install fails', async () => {
  const installs = heldInstalls();
  const queue = new InstallQueue();

  const first = launchPackage(installs, queue, 'npm:first');
  const second = launchPackage(installs, queue, 'npm:second');

  await installs.whenStarted('npm:first');
  expect(installs.started).toEqual(['npm:first']);
  installs.settle('npm:first', 'failed');

  await expect(first).rejects.toThrow('Worker profile package npm:first failed to install');
  await installs.whenStarted('npm:second');
  installs.settle('npm:second', 'installed');

  await expect(second).resolves.toEqual(['npm:second']);
  expect(installs.mostRunning()).toBe(1);
});
