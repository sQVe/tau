import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import type { KnownKeys } from '../schema.js';
import type { ConfigWarnings } from './config.js';
import { readRepositorySection } from './repositorySection.js';

const ui = { notify: () => undefined };

const fixture = () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-repository-section-');
  const agentDirectory = join(directory, 'agent');
  const userFile = join(agentDirectory, 'tau.json');

  mkdirSync(agentDirectory);

  return {
    location: { cwd: directory, agentDirectory, projectTrusted: true },
    userFile,
    write: (value: unknown) => {
      writeFileSync(userFile, JSON.stringify(value));
    },
  };
};

const readEntry = vi.fn<(source: string, field: string, value: unknown) => unknown>(
  (_source, field, value) => ({ field, value }),
);

beforeEach(() => {
  readEntry.mockClear();
});

const reader = (key: string, repository: string | undefined) => ({
  key,
  knownEntryKeys: { setting: true } satisfies KnownKeys,
  example: '{"repositories": {"sQVe/tau": {"setting": 1}}}',
  repository,
  readEntry,
});

it.each(['fullCheck', 'qa', 'reviews'])(
  'refuses an entry key that is not owner/name in %s',
  (key) => {
    const { location, write, userFile } = fixture();

    write({ [key]: { repositories: { tau: { setting: 1 } } } });

    expect(() => readRepositorySection(location, ui, reader(key, 'tau'))).toThrow(
      `Invalid Tau config ${userFile}: "tau" in ${key}.repositories must be an owner/name such as "sQVe/tau".`,
    );

    expect(readEntry).not.toHaveBeenCalled();
  },
);

it('returns the checked section beside the matched entry', () => {
  const { location, write, userFile } = fixture();
  const section = { agentTeam: 'AI', repositories: { 'sQVe/tau': { setting: 1 } } };

  write({ tracker: section });

  expect(
    readRepositorySection(location, ui, {
      ...reader('tracker', 'sQVe/tau'),
      knownSectionKeys: { agentTeam: true },
    }),
  ).toEqual({
    source: userFile,
    section,
    entry: { field: 'tracker.repositories.sQVe/tau', value: { setting: 1 } },
  });
});

it('reads the matched entry with its field name', () => {
  const { location, write, userFile } = fixture();

  write({ qa: { repositories: { 'sQVe/tau': { setting: 1 } } } });

  expect(readRepositorySection(location, ui, reader('qa', 'sqve/tau'))?.entry).toEqual({
    field: 'qa.repositories.sQVe/tau',
    value: { setting: 1 },
  });

  expect(readEntry).toHaveBeenCalledWith(userFile, 'qa.repositories.sQVe/tau', { setting: 1 });
});

it.each([
  { condition: 'the user file is missing', user: undefined },
  { condition: 'the section is unset', user: { other: 1 } },
])('reads no section when $condition', ({ user }) => {
  const { location, write } = fixture();

  if (user !== undefined) {
    write(user);
  }

  expect(readRepositorySection(location, ui, reader('qa', 'sQVe/tau'))).toBeUndefined();
  expect(readEntry).not.toHaveBeenCalled();
});

it.each([
  { condition: 'repositories is unset', user: { qa: {} }, repository: 'sQVe/tau' },
  {
    condition: 'the repository is unknown',
    user: { qa: { repositories: { 'sQVe/tau': { setting: 1 } } } },
    repository: undefined,
  },
  {
    condition: 'the repository has no entry',
    user: { qa: { repositories: { 'sQVe/other': { setting: 1 } } } },
    repository: 'sQVe/tau',
  },
  {
    condition: 'another repository has a key that is not owner/name',
    user: { qa: { repositories: { other: 1 } } },
    repository: 'sQVe/tau',
  },
])('reads no entry when $condition', ({ user, repository }) => {
  const { location, write } = fixture();

  write(user);

  expect(readRepositorySection(location, ui, reader('qa', repository))?.entry).toBeUndefined();
  expect(readEntry).not.toHaveBeenCalled();
});

it.each([
  {
    condition: 'the section is not an object',
    qa: 'on',
    error: 'qa must be an object such as {"repositories": {"sQVe/tau": {"setting": 1}}}.',
  },
  {
    condition: 'repositories is a list',
    qa: { repositories: [] },
    error: 'qa.repositories must be an object keyed by owner/name.',
  },
  {
    condition: 'two keys differ only in case',
    qa: { repositories: { 'sQVe/tau': {}, 'sqve/tau': {} } },
    error: 'name the same repository',
  },
])('refuses the section when $condition', ({ qa, error }) => {
  const { location, write } = fixture();

  write({ qa });

  expect(() => readRepositorySection(location, ui, reader('qa', 'sQVe/tau'))).toThrow(error);
});

it('refuses a section set in a repository file', () => {
  const { location } = fixture();

  writeFileSync(join(location.cwd, 'tau.json'), '{}');
  mkdirSync(join(location.cwd, '.pi'));
  writeFileSync(join(location.cwd, '.pi', 'tau.json'), JSON.stringify({ qa: {} }));

  expect(() => readRepositorySection(location, ui, reader('qa', 'sQVe/tau'))).toThrow(
    'qa may be set only in the user file',
  );
});

it('warns about unknown keys at any depth and still reads the entry', () => {
  const { location, write, userFile } = fixture();
  const notify = vi.fn<ConfigWarnings['notify']>();

  write({ qa: { future: 1, repositories: { 'sQVe/tau': { setting: 1, extra: 2 } } } });

  readRepositorySection(location, { notify }, reader('qa', 'sQVe/tau'));

  const messages = notify.mock.calls.map(([message]) => message).join('\n');

  expect(messages).toContain(userFile);
  expect(messages).toContain('qa.future');
  expect(messages).toContain('qa.repositories.sQVe/tau.extra');
  expect(readEntry).toHaveBeenCalledOnce();
});
