import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { readProfileModels } from '../src/extensions/subagents/profileModels.js';
import { loadTddConfig } from '../src/extensions/tdd/config.js';
import { readAllowedModels } from '../src/models/models.js';

const writeConfig = (path: string, value: unknown) => {
  writeFileSync(path, JSON.stringify(value));
};

const configFixture = (onTestFinished: (callback: () => void) => void) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-config-readers-'));
  const agentDirectory = join(directory, 'agent');

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(agentDirectory);
  mkdirSync(join(directory, '.pi'));
  const location = { cwd: directory, agentDirectory, projectTrusted: true };

  return {
    location,
    userFile: join(agentDirectory, 'tau.json'),
    repositoryFile: join(directory, '.pi', 'tau.json'),
  };
};

it('leaves TDD config, profiles, and allowed models readable when bulkRead is broken', ({
  onTestFinished,
}) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  writeConfig(userFile, {
    allowedModels: ['a/one'],
    profiles: { scout: { model: 'a/one' } },
    bulkRead: 'broken',
  });

  writeConfig(repositoryFile, { bulkRead: {}, tdd: { productionGlobs: ['lib/**'] } });

  expect(readAllowedModels(location)?.models).toEqual(['a/one']);
  expect(readProfileModels(location)).toEqual(new Map([['scout', 'a/one']]));
  expect(loadTddConfig(location).config.productionGlobs).toEqual(['lib/**']);
});

it('leaves TDD config, profiles, and allowed models readable next to a bulkRead model', ({
  onTestFinished,
}) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  writeConfig(userFile, {
    allowedModels: ['a/one'],
    profiles: { scout: { model: 'a/one' } },
    bulkRead: { model: 'openai-codex/gpt-5.6-luna' },
  });

  writeConfig(repositoryFile, { tdd: { productionGlobs: ['lib/**'] } });

  expect(readAllowedModels(location)?.models).toEqual(['a/one']);
  expect(readProfileModels(location)).toEqual(new Map([['scout', 'a/one']]));
  expect(loadTddConfig(location).config.productionGlobs).toEqual(['lib/**']);
});
