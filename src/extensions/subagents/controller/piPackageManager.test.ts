import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { fixtureLoadout } from '../fixtures/loadout.js';
import { piPackageManager } from './piPackageManager.js';

it('lists the user and trusted project packages the worker will load', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-packages-');

  const cwd = join(root, 'project');
  const agentDirectory = join(root, 'agent');
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  mkdirSync(agentDirectory, { recursive: true });

  writeFileSync(
    join(agentDirectory, 'settings.json'),
    JSON.stringify({ packages: ['npm:user-package'] }),
  );

  writeFileSync(
    join(cwd, '.pi', 'settings.json'),
    JSON.stringify({ packages: ['npm:project-package'] }),
  );

  const configured = piPackageManager({
    ...fixtureLoadout(cwd),
    agentDirectory,
  })
    .listConfiguredPackages()
    .map(({ source, scope }) => ({ source, scope }));

  expect(configured.toSorted((left, right) => left.source.localeCompare(right.source))).toEqual([
    { source: 'npm:project-package', scope: 'project' },
    { source: 'npm:user-package', scope: 'user' },
  ]);
});
