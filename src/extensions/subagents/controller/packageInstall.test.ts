import { getEventListeners } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ResolvedPaths } from '@earendil-works/pi-coding-agent';
import { beforeEach, expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { fixtureLoadout } from '../fixtures/loadout.js';
import {
  fakePackageRoot,
  fakePackageSnapshot,
  launchIdFor,
  snapshotDirectory,
  sourceSnapshotDirectory,
  writeFakePackage,
} from './fixtures/packageCache.js';
import { installWorkerPackages } from './packageInstall.js';
import type { WorkerPackageManager } from './packageInstall.js';
import { piPackageManager } from './piPackageManager.js';

const installedPackage = (source: string, launchId = 'launch') => ({
  source,
  path: fakePackageSnapshot(loadout.agentDirectory, launchId, source),
});

const localPackage = (path: string) => ({ source: path, path });

const resolved = (extension: string, packageRoot?: string): ResolvedPaths => ({
  extensions: [
    {
      path: extension,
      enabled: true,
      metadata: {
        source: extension,
        scope: 'temporary',
        origin: 'package',
        ...(packageRoot === undefined ? {} : { packageRoot }),
      },
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

      if (failing.has(`empty:${source}`)) {
        return Promise.resolve({ ...resolved(''), extensions: [] });
      }

      if (failing.has(`noroot:${source}`)) {
        return Promise.resolve(resolved(source));
      }

      const path = fakePackageRoot(loadout.agentDirectory, source);

      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'content.txt'), source);

      return Promise.resolve(resolved(source, path));
    },
  };

  return { manager, installs };
};

const signal = new AbortController().signal;

let loadout = fixtureLoadout('/work');

beforeEach(() => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-package-cache-');

  loadout = { ...fixtureLoadout('/work'), agentDirectory };
});

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
    signal,
    snapshotDirectory(loadout.agentDirectory, 'launch'),
  );

  expect(sources).toEqual([
    installedPackage('npm:pi-codex-image-gen'),
    localPackage(join('/work', 'probe')),
  ]);

  expect(installs).toEqual([
    { sources: ['npm:pi-codex-image-gen'], temporary: true },
    { sources: [join('/work', 'probe')], temporary: true },
  ]);
});

it('skips a local profile package that user settings name relative to the agent directory', async () => {
  const { manager, installs } = fakeManager([{ source: './probe', scope: 'user' }]);

  const sources = await installWorkerPackages(
    { ...loadout, packages: [join(loadout.agentDirectory, 'probe')] },
    () => manager,
    signal,
  );

  expect(sources).toEqual([]);
  expect(installs).toEqual([]);
});

it('skips a local profile package that user settings name as npm with a leading space', async () => {
  const { manager, installs } = fakeManager([{ source: ' npm:probe', scope: 'user' }]);

  const sources = await installWorkerPackages(
    { ...loadout, packages: [join(loadout.agentDirectory, 'npm:probe')] },
    () => manager,
    signal,
  );

  expect(sources).toEqual([]);
  expect(installs).toEqual([]);
});

it('reads a profile package named npm with a leading space as a local path', async () => {
  const { manager } = fakeManager([]);

  const sources = await installWorkerPackages(
    { ...loadout, packages: [' npm:probe'] },
    () => manager,
    signal,
    snapshotDirectory(loadout.agentDirectory, 'launch'),
  );

  expect(sources).toEqual([localPackage(join('/work', 'npm:probe'))]);
});

it('passes git profile packages to Pi unresolved, with or without a leading space', async () => {
  const { manager } = fakeManager([]);

  const sources = await installWorkerPackages(
    { ...loadout, packages: ['git:github.com/user/tool', ' https://github.com/user/other'] },
    () => manager,
    signal,
    snapshotDirectory(loadout.agentDirectory, 'launch'),
  );

  expect(sources).toEqual([
    installedPackage('git:github.com/user/tool'),
    installedPackage(' https://github.com/user/other'),
  ]);
});

it('keeps the first launch package content when a later install replaces the shared cache', async () => {
  const { manager } = fakeManager([]);
  const packages = (source: string) => ({ ...loadout, packages: [source] });

  const first = await installWorkerPackages(
    packages('npm:shared@1'),
    () => manager,
    signal,
    snapshotDirectory(loadout.agentDirectory, 'first'),
  );

  const second = await installWorkerPackages(
    packages('npm:shared@2'),
    () => manager,
    signal,
    snapshotDirectory(loadout.agentDirectory, 'second'),
  );

  expect(readFileSync(join(first[0]!.path, 'content.txt'), 'utf8')).toBe('npm:shared@1');
  expect(readFileSync(join(second[0]!.path, 'content.txt'), 'utf8')).toBe('npm:shared@2');
});

it.each([
  {
    source: 'npm:@scope/tool@1',
    unitPath: 'npm/shared',
    packagePath: 'node_modules/@scope/tool',
    dependencyPath: 'node_modules/dependency',
  },
  {
    source: 'git:github.com/user/tool',
    unitPath: 'git/github.com/user/tool',
    packagePath: '.',
    dependencyPath: 'node_modules/dependency',
  },
])(
  'copies the install unit and preserves symlinks for $source',
  async ({ source, unitPath, packagePath, dependencyPath }) => {
    const unit = join(loadout.agentDirectory, 'tmp', 'extensions', unitPath);
    const root = join(unit, packagePath);
    const dependency = join(unit, dependencyPath);

    mkdirSync(root, { recursive: true });
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(root, 'content.txt'), 'first package');
    writeFileSync(join(dependency, 'content.txt'), 'first dependency');
    symlinkSync('content.txt', join(dependency, 'linked.txt'));

    const manager: WorkerPackageManager = {
      listConfiguredPackages: () => [],
      resolveExtensionSources: () => Promise.resolve(resolved(source, root)),
    };

    const snapshot = snapshotDirectory(loadout.agentDirectory, 'unit');

    const packages = await installWorkerPackages(
      { ...loadout, packages: [source] },
      () => manager,
      signal,
      snapshot,
    );

    writeFileSync(join(root, 'content.txt'), 'replaced package');
    writeFileSync(join(dependency, 'content.txt'), 'replaced dependency');
    const sourceDirectory = sourceSnapshotDirectory(snapshot, source);
    const copiedDependency = join(sourceDirectory, unitPath, dependencyPath);

    expect(packages[0]!.path).toBe(join(sourceDirectory, unitPath, packagePath));
    expect(readFileSync(join(packages[0]!.path, 'content.txt'), 'utf8')).toBe('first package');
    expect(readFileSync(join(copiedDependency, 'linked.txt'), 'utf8')).toBe('first dependency');
    expect(readlinkSync(join(copiedDependency, 'linked.txt'))).toBe('content.txt');
    expect(statSync(snapshot).mode & 0o777).toBe(0o700);
  },
);

it('keeps each source snapshot when another install replaces the prefix between sources', async () => {
  const { manager } = fakeManager([]);
  const resolveSources = manager.resolveExtensionSources;

  manager.resolveExtensionSources = async (sources, options) => {
    if (sources[0] === 'npm:other') {
      await resolveSources(['npm:shared@2'], options);
    }

    return resolveSources(sources, options);
  };

  const packages = await installWorkerPackages(
    { ...loadout, packages: ['npm:shared@1', 'npm:other'] },
    () => manager,
    signal,
    snapshotDirectory(loadout.agentDirectory, 'interleaved'),
  );

  const cache = fakePackageRoot(loadout.agentDirectory, 'npm:shared@1');

  expect(readFileSync(join(cache, 'content.txt'), 'utf8')).toBe('npm:shared@2');
  expect(readFileSync(join(packages[0]!.path, 'content.txt'), 'utf8')).toBe('npm:shared@1');
  expect(readFileSync(join(packages[1]!.path, 'content.txt'), 'utf8')).toBe('npm:other');
});

it('fails a launch whose package cannot be snapshotted and leaves no snapshot', async () => {
  const source = 'npm:missing';

  const missingRoot = join(
    loadout.agentDirectory,
    'tmp',
    'extensions',
    'npm',
    'shared',
    'node_modules',
    'missing',
  );

  const manager: WorkerPackageManager = {
    listConfiguredPackages: () => [],
    resolveExtensionSources: () => Promise.resolve(resolved(source, missingRoot)),
  };

  const launchId = 'broken';
  const snapshot = snapshotDirectory(loadout.agentDirectory, launchId);

  const failure = await installWorkerPackages(
    { ...loadout, packages: [source] },
    () => manager,
    signal,
    snapshot,
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(source);
  expect((failure as Error).message).toContain('snapshot');
  expect(existsSync(snapshot)).toBe(false);
});

const pendingManager = (): WorkerPackageManager => ({
  listConfiguredPackages: () => [],
  resolveExtensionSources: () => new Promise(() => {}),
});

it.each([
  {
    reason: new DOMException('Launch cancelled.', 'AbortError'),
    stop: 'was cancelled',
  },
  {
    reason: new DOMException('Budget spent.', 'TimeoutError'),
    stop: 'ran out of launch time',
  },
])('names the package when its install $stop', async ({ reason, stop }) => {
  const abort = new AbortController();
  const packages = { ...loadout, packages: ['npm:slow', 'npm:later'] };

  const installing = installWorkerPackages(packages, pendingManager, abort.signal);

  abort.abort(reason);

  await expect(installing).rejects.toThrow(`Worker profile package npm:slow install ${stop}.`);
});

it('reads a file URL package as the local path it names', async () => {
  const { manager, installs } = fakeManager([{ source: 'file:///work/shared', scope: 'user' }]);

  const sources = await installWorkerPackages(
    { ...loadout, packages: ['/work/shared', 'file:///work/probe'] },
    () => manager,
    signal,
    snapshotDirectory(loadout.agentDirectory, 'launch'),
  );

  expect(sources).toEqual([localPackage('/work/probe')]);
  expect(existsSync(snapshotDirectory(loadout.agentDirectory, 'launch'))).toBe(false);
  expect(installs.map((install) => install.sources)).toEqual([['/work/probe']]);
});

it('stops at the first package that fails to install and names it', async () => {
  const { manager, installs } = fakeManager([], new Set(['npm:broken']));

  await expect(
    installWorkerPackages(
      { ...loadout, packages: ['npm:broken', 'npm:later'] },
      () => manager,
      signal,
    ),
  ).rejects.toThrow('Worker profile package npm:broken failed to install: npm install failed');

  expect(installs.map(({ sources }) => sources)).toEqual([['npm:broken']]);
});

it('refuses a package that installs no Pi resources and names it', async () => {
  const { manager } = fakeManager([], new Set(['empty:npm:offline']));

  await expect(
    installWorkerPackages({ ...loadout, packages: ['npm:offline'] }, () => manager, signal),
  ).rejects.toThrow('Worker profile package npm:offline');
});

it('refuses a remote package whose resources have no package root and names it', async () => {
  const { manager } = fakeManager([], new Set(['noroot:npm:noroot']));

  await expect(
    installWorkerPackages({ ...loadout, packages: ['npm:noroot'] }, () => manager, signal),
  ).rejects.toThrow(
    'Worker profile package npm:noroot installed without a package root; check the source.',
  );
});

const settingsRead = (): WorkerPackageManager => {
  throw new Error('settings read');
};

it('reads no settings for a profile without packages', async () => {
  await expect(installWorkerPackages(loadout, settingsRead, signal)).resolves.toEqual([]);
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
      install?.resolve(resolved(source, writeFakePackage(loadout.agentDirectory, source)));
    } else {
      install?.reject(new Error('npm install failed'));
    }
  };

  return {
    manager,
    started,
    whenStarted,
    settle,
    mostRunning: () => mostRunning,
  };
};

const launchPackage = (
  installs: ReturnType<typeof heldInstalls>,
  source: string,
  launchSignal = signal,
) =>
  installWorkerPackages(
    { ...loadout, packages: [source] },
    installs.manager,
    launchSignal,
    snapshotDirectory(loadout.agentDirectory, launchIdFor(source)),
  );

const launchedPackage = (source: string) => installedPackage(source, launchIdFor(source));

it('lets a queued launch stop waiting without blocking the launch behind it', async () => {
  const installs = heldInstalls();
  const cancel = new AbortController();

  const first = launchPackage(installs, 'npm:first');

  await installs.whenStarted('npm:first');
  const second = launchPackage(installs, 'npm:second', cancel.signal);
  const third = launchPackage(installs, 'npm:third');
  cancel.abort();

  await expect(second).rejects.toThrow('Worker profile package npm:second install was cancelled.');
  expect(installs.started).toEqual(['npm:first']);

  installs.settle('npm:first', 'installed');
  await installs.whenStarted('npm:third');
  installs.settle('npm:third', 'installed');

  await expect(first).resolves.toEqual([launchedPackage('npm:first')]);
  await expect(third).resolves.toEqual([launchedPackage('npm:third')]);
  expect(installs.started).toEqual(['npm:first', 'npm:third']);
  expect(installs.mostRunning()).toBe(1);
});

it('waits for an abandoned install to settle before the next one starts', async () => {
  const installs = heldInstalls();
  const cancel = new AbortController();

  const first = launchPackage(installs, 'npm:first', cancel.signal);

  await installs.whenStarted('npm:first');
  const second = launchPackage(installs, 'npm:second');
  cancel.abort();

  await expect(first).rejects.toThrow('npm:first install was cancelled');
  expect(installs.started).toEqual(['npm:first']);

  installs.settle('npm:first', 'installed');
  await installs.whenStarted('npm:second');
  installs.settle('npm:second', 'installed');

  await expect(second).resolves.toEqual([launchedPackage('npm:second')]);
  expect(installs.mostRunning()).toBe(1);
});

it('starts the next queued install after an install fails', async () => {
  const installs = heldInstalls();
  const first = launchPackage(installs, 'npm:first');

  await installs.whenStarted('npm:first');
  const second = launchPackage(installs, 'npm:second');
  expect(installs.started).toEqual(['npm:first']);
  installs.settle('npm:first', 'failed');

  await expect(first).rejects.toThrow('Worker profile package npm:first failed to install');
  await installs.whenStarted('npm:second');
  installs.settle('npm:second', 'installed');

  await expect(second).resolves.toEqual([launchedPackage('npm:second')]);
  expect(installs.mostRunning()).toBe(1);
});

it('skips a local profile package that project settings name relative to the project settings directory', async () => {
  const { manager, installs } = fakeManager([{ source: './probe', scope: 'project' }]);

  const sources = await installWorkerPackages(
    { ...loadout, packages: ['.pi/probe'] },
    () => manager,
    signal,
  );

  expect(sources).toEqual([]);
  expect(installs).toEqual([]);
});

it('expands a home directory and trims whitespace in local profile packages', async () => {
  const { manager } = fakeManager([]);

  const sources = await installWorkerPackages(
    { ...loadout, packages: ['~', '~/probe', ' /work/spaced '] },
    () => manager,
    signal,
    snapshotDirectory(loadout.agentDirectory, 'launch'),
  );

  expect(sources).toEqual([
    localPackage(homedir()),
    localPackage(join(homedir(), 'probe')),
    localPackage('/work/spaced'),
  ]);
});

it('keeps the install error as the cause of a failed package install', async () => {
  const { manager } = fakeManager([], new Set(['npm:broken']));

  const failure = await installWorkerPackages(
    { ...loadout, packages: ['npm:broken'] },
    () => manager,
    signal,
  ).catch((error: unknown) => error);

  expect((failure as Error).cause).toEqual(new Error('npm install failed'));
});

it.each([
  { setting: ' npm:probe.ts', file: 'npm:probe.ts' },
  { setting: 'github:probe.ts', file: 'github:probe.ts' },
  { setting: 'http:probe.ts', file: 'http:probe.ts' },
  { setting: 'https:probe.ts', file: 'https:probe.ts' },
])(
  'skips a profile package that Pi already loads from the local settings source $setting',
  async ({ setting, file }) => {
    const root = temporaryDirectory(onTestFinished, 'tau-packages-');

    const cwd = join(root, 'project');
    const agentDirectory = join(root, 'agent');
    const extension = join(agentDirectory, file);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(dirname(extension), { recursive: true });
    writeFileSync(extension, 'export default () => {};\n');

    writeFileSync(join(agentDirectory, 'settings.json'), JSON.stringify({ packages: [setting] }));

    const workerLoadout = { ...fixtureLoadout(cwd), agentDirectory, packages: [extension] };

    const piLoads = await new DefaultPackageManager({
      cwd,
      agentDir: agentDirectory,
      settingsManager: SettingsManager.create(cwd, agentDirectory),
    }).resolve();

    const sources = await installWorkerPackages(workerLoadout, piPackageManager, signal);

    expect(piLoads.extensions.map((resource) => resource.path)).toEqual([extension]);
    expect(sources).toEqual([]);
  },
);

// A launch can stop in the very tick its turn comes. The signal reports the stop only once the
// first install settled, so the queue sees it exactly when the turn passes.
it('does not install for a launch that stopped when its turn came', async () => {
  const installs = heldInstalls();
  const cancel = new AbortController();
  let turnCame = false;

  Object.defineProperty(cancel.signal, 'aborted', { get: () => turnCame });

  const first = launchPackage(installs, 'npm:first');

  await installs.whenStarted('npm:first');
  const second = launchPackage(installs, 'npm:second', cancel.signal);
  const third = launchPackage(installs, 'npm:third');
  const secondOutcome = second.catch((error: unknown) => error);
  turnCame = true;
  installs.settle('npm:first', 'installed');

  await expect(first).resolves.toEqual([launchedPackage('npm:first')]);
  expect(await secondOutcome).toBeInstanceOf(Error);
  await installs.whenStarted('npm:third');
  installs.settle('npm:third', 'installed');

  await expect(third).resolves.toEqual([launchedPackage('npm:third')]);
  expect(installs.started).toEqual(['npm:first', 'npm:third']);
});

it('stops a launch whose signal was already aborted without waiting for the queue', async () => {
  const installs = heldInstalls();
  const stopped = new AbortController();

  stopped.abort();
  const first = launchPackage(installs, 'npm:first');
  await installs.whenStarted('npm:first');

  await expect(launchPackage(installs, 'npm:second', stopped.signal)).rejects.toThrow('npm:second');

  installs.settle('npm:first', 'installed');
  await expect(first).resolves.toEqual([launchedPackage('npm:first')]);
  expect(installs.started).toEqual(['npm:first']);
});

it('leaves no abort listener on the launch signal once its install settled', async () => {
  const installs = heldInstalls();
  const launch = new AbortController();

  const first = launchPackage(installs, 'npm:first', launch.signal);

  await installs.whenStarted('npm:first');
  installs.settle('npm:first', 'installed');
  await expect(first).resolves.toEqual([launchedPackage('npm:first')]);

  expect(getEventListeners(launch.signal, 'abort')).toHaveLength(0);
});

it('reports a cancelled install as stopped, not as an install failure', async () => {
  const installs = heldInstalls();
  const cancel = new AbortController();

  const only = launchPackage(installs, 'npm:only', cancel.signal);
  const outcome = only.catch((error: unknown) => error);

  await installs.whenStarted('npm:only');
  cancel.abort();

  const error = await outcome;

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain('failed to install');
  expect((error as Error).cause).toBeUndefined();
});
