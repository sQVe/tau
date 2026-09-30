import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { readAllowedModels } from '../../models/index.js';
import { readProfileModels } from './profileModels.js';

const writeConfig = (path: string, value: unknown) => {
  writeFileSync(path, JSON.stringify(value));
};

const configFixture = (onTestFinished: (callback: () => void) => void) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-profile-models-'));
  const agentDirectory = join(directory, 'agent');
  const userFile = join(agentDirectory, 'tau.json');
  const repositoryFile = join(directory, '.pi', 'tau.json');

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(agentDirectory);
  mkdirSync(join(directory, '.pi'));
  const location = { cwd: directory, agentDirectory, projectTrusted: true };

  return { location, userFile, repositoryFile };
};

it('reads profile models from the user file', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, {
    allowedModels: ['a/one'],
    profiles: { scout: { model: 'a/scout' }, default: { model: 'openrouter/meta/llama' } },
  });

  expect(readProfileModels(location)).toEqual(
    new Map([
      ['scout', 'a/scout'],
      ['default', 'openrouter/meta/llama'],
    ]),
  );
});

it('reads no profile models without config files or a profiles block', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  expect(readProfileModels(location)).toEqual(new Map());

  writeConfig(userFile, { allowedModels: ['a/one'] });
  writeConfig(repositoryFile, { tdd: {} });

  expect(readProfileModels(location)).toEqual(new Map());
});

it.for<[string, unknown, string]>([
  ['a non-object profiles block', ['scout'], 'profiles'],
  ['a non-object entry', { scout: 'a/scout' }, 'profiles.scout'],
  ['an unknown key', { scout: { model: 'a/scout', thinking: 'high' } }, 'profiles.scout.thinking'],
  ['a missing model', { default: {} }, 'profiles.default.model'],
  ['a malformed model', { scout: { model: 'no-provider' } }, 'profiles.scout.model'],
  ['a non-string model', { scout: { model: 5 } }, 'profiles.scout.model'],
])('refuses %s and names the file and field', ([, profiles, field], { onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { profiles });

  const read = () => readProfileModels(location);

  expect(read).toThrow(userFile);
  expect(read).toThrow(field);
});

it('refuses profiles in the repository file and names that file', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  writeConfig(userFile, { profiles: { scout: { model: 'a/scout' } } });
  writeConfig(repositoryFile, { profiles: {} });

  expect(() => readProfileModels(location)).toThrow(repositoryFile);

  expect(readProfileModels({ ...location, projectTrusted: false })).toEqual(
    new Map([['scout', 'a/scout']]),
  );
});

it('leaves allowed models readable when profiles are broken', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  writeConfig(userFile, { allowedModels: ['a/one'], profiles: { scout: 'broken' } });
  writeConfig(repositoryFile, { profiles: {} });

  expect(() => readProfileModels(location)).toThrow('profiles');
  expect(readAllowedModels(location)?.models).toEqual(['a/one']);
});
