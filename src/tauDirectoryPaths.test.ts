import { readdir } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { createTemporaryRepository } from '../tests/gitRepository.js';
import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.js';
import {
  checkTauDirectory,
  climbsOut,
  createFreshTauDirectory,
  ensureTauDirectory,
  locateTauChild,
  requireTauChild,
} from './tauDirectory.js';

const listTree = async (directory: string) =>
  (await readdir(directory, { recursive: true })).toSorted();

it.for(['', '../outside', 'slices/../..', '/tmp/outside', 'slices//me-479'])(
  'refuses the path %j and creates nothing',
  async (path, { onTestFinished }) => {
    const root = temporaryDirectory(onTestFinished, 'tau-directory-');

    await expect(ensureTauDirectory(root, path)).rejects.toBeInstanceOf(Error);

    expect(await readdir(root)).toEqual([]);
  },
);

it.for([String.raw`..\outside`, String.raw`slices\me-479`])(
  'refuses the path %j with a backslash in a repository and creates nothing',
  async (path, { onTestFinished }) => {
    const repository = await createTemporaryRepository(onTestFinished);
    const before = await readdir(repository);

    await expect(ensureTauDirectory(repository, path)).rejects.toThrow(path);

    expect(await readdir(repository)).toEqual(before);
  },
);

it.for(['../review-', String.raw`..\review-`])(
  'refuses the fresh directory prefix %j with a separator and creates nothing',
  async (prefix, { onTestFinished }) => {
    const root = temporaryDirectory(onTestFinished, 'tau-directory-');

    await expect(createFreshTauDirectory(root, 'workers', prefix)).rejects.toThrow(prefix);

    expect(await readdir(root)).toEqual([]);
  },
);

it.for(['..', '.', ''])(
  'refuses the fresh directory prefix %j and creates nothing',
  async (prefix, { onTestFinished }) => {
    const root = temporaryDirectory(onTestFinished, 'tau-directory-');

    await expect(createFreshTauDirectory(root, 'workers', prefix)).rejects.toBeInstanceOf(Error);

    expect(await readdir(root)).toEqual([]);
  },
);

it.each([
  { directory: '.tau/pr/run-x', prefix: 'run-', place: { kind: 'child', name: 'run-x' } },
  { directory: '.tau/pr/..run-x', prefix: '..run-', place: { kind: 'child', name: '..run-x' } },
  { directory: '.tau/pr/..run-x', prefix: 'run-', place: { kind: 'unnamed' } },
  { directory: '.tau/pr/run-', prefix: 'run-', place: { kind: 'unnamed' } },
  { directory: '.tau/pr/run-x/body', prefix: 'run-', place: { kind: 'nested' } },
  { directory: '.tau/pr/..', prefix: 'run-', place: { kind: 'outside' } },
  { directory: '.tau/pr/../x', prefix: 'run-', place: { kind: 'outside' } },
  { directory: String.raw`.tau/pr/..\x`, prefix: 'run-', place: { kind: 'outside' } },
  { directory: '/elsewhere/run-x', prefix: 'run-', place: { kind: 'outside' } },
])('places $directory with prefix $prefix as $place.kind', ({ directory, prefix, place }) => {
  expect(locateTauChild('/repository', 'pr', prefix, directory)).toEqual(place);
});

it.for(['', '.', '..', 'a/..', '../x', 'a//b', 'a/./b'])(
  'refuses the Tau directory path %j in a Git repository before it writes',
  async (path, { onTestFinished }) => {
    const repository = await createTemporaryRepository(onTestFinished);
    const before = await listTree(repository);

    await expect(ensureTauDirectory(repository, path)).rejects.toThrow('below .tau');
    await expect(checkTauDirectory(repository, path)).rejects.toThrow('below .tau');

    expect(await listTree(repository)).toEqual(before);
  },
);

it.for(['', '.', '..'])(
  'refuses the fresh directory prefix %j in a Git repository before it writes',
  async (prefix, { onTestFinished }) => {
    const repository = await createTemporaryRepository(onTestFinished);
    const before = await listTree(repository);

    await expect(createFreshTauDirectory(repository, 'workers', prefix)).rejects.toThrow(
      'must be a name',
    );

    expect(await listTree(repository)).toEqual(before);
  },
);

it.each([
  { directory: '.tau/pr/..run-x', prefix: '', name: '..run-x' },
  { directory: '.tau/pr/run-x', prefix: 'run-', name: 'run-x' },
])('accepts $directory with prefix "$prefix" as the Tau child $name', (row) => {
  expect(
    requireTauChild('/repository', 'pr', row.prefix, row.directory, 'The body directory'),
  ).toBe(row.name);
});

it.each([
  {
    directory: '.tau/pr/../x',
    prefix: '',
    error: 'The body directory must be in .tau/pr, not .tau/pr/../x.',
  },
  {
    directory: '/elsewhere/x',
    prefix: '',
    error: 'The body directory must be in .tau/pr, not /elsewhere/x.',
  },
  {
    directory: '.tau/pr/a/b',
    prefix: '',
    error: 'The body directory must sit directly in .tau/pr, not .tau/pr/a/b.',
  },
  {
    directory: '.tau/pr',
    prefix: '',
    error: 'The body directory must name a directory in .tau/pr, not .tau/pr.',
  },
  {
    directory: '.tau/pr/other',
    prefix: 'run-',
    error: 'The body directory must be named run-* by prepare, not .tau/pr/other.',
  },
])('refuses $directory with prefix "$prefix" as a Tau child', (row) => {
  expect(() =>
    requireTauChild('/repository', 'pr', row.prefix, row.directory, 'The body directory'),
  ).toThrow(row.error);
});

it.each([
  { path: '..', climbs: true },
  { path: '../a', climbs: true },
  { path: '/etc', climbs: true },
  { path: String.raw`..\x`, climbs: true },
  { path: String.raw`a\b/../..`, climbs: true },
  { path: '..rules.md', climbs: false },
  { path: '..run-x', climbs: false },
  { path: 'a/../b', climbs: false },
  { path: '', climbs: false },
])('says whether the relative path $path climbs out', ({ path, climbs }) => {
  expect(climbsOut(path)).toBe(climbs);
});
