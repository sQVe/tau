import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { allocateName } from './names.js';

const savedTask = join(import.meta.dirname, 'fixtures', 'taskRecords', 'current-pi.json');

const allocation = (root: string, parentSessionId: string) => {
  const suffixes = ['ab', 'cd'];

  return {
    root,
    parentSessionId,
    loadout: { ...fixtureLoadout(root), profile: 'scout', role: 'investigation' as const },
    live: [],
    suffix: () => suffixes.shift() ?? 'zz',
  };
};

const rootWithSavedScout = () => {
  const root = temporaryDirectory(onTestFinished, 'tau-names-');

  mkdirSync(join(root, 'current-pi'));
  copyFileSync(savedTask, join(root, 'current-pi', 'task.json'));

  return root;
};

it('allocates a name before any task root exists', () => {
  const root = join(temporaryDirectory(onTestFinished, 'tau-names-'), 'tasks');

  expect(allocateName(allocation(root, 'parent-one'))).toBe('scout-ab');
});

it('refuses to allocate a name when the task root cannot be listed', () => {
  const root = join(temporaryDirectory(onTestFinished, 'tau-names-'), 'tasks');

  writeFileSync(root, '');

  expect(() => allocateName(allocation(root, 'parent-one'))).toThrow('ENOTDIR');
});

it.each([
  { session: 'the same parent session', parentSessionId: 'parent-one', name: 'scout-cd' },
  { session: 'another parent session', parentSessionId: 'parent-two', name: 'scout-ab' },
])(
  'treats a saved name from $session as taken only for that session',
  ({ parentSessionId, name }) => {
    expect(allocateName(allocation(rootWithSavedScout(), parentSessionId))).toBe(name);
  },
);
