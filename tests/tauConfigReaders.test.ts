import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { readBulkReadModel } from '../src/extensions/bulkRead/config.js';
import { loadCompactionConfig } from '../src/extensions/compaction/config.js';
import { readProfileModels } from '../src/extensions/subagents/profileModels.js';
import { loadTddConfig } from '../src/extensions/tdd/config.js';
import { readAllowedModels } from '../src/models/index.js';

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

it('leaves TDD config, profiles, allowed models, and compaction readable when bulkRead is broken', ({
  onTestFinished,
}) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  writeConfig(userFile, {
    allowedModels: ['a/one'],
    profiles: { scout: { model: 'a/one' } },
    bulkRead: 'broken',
  });

  writeConfig(repositoryFile, {
    bulkRead: {},
    tdd: { productionGlobs: ['lib/**'] },
    compaction: { reminderTokens: 150_000 },
  });

  expect(() => readBulkReadModel(location)).toThrow('bulkRead');
  expect(readAllowedModels(location)?.models).toEqual(['a/one']);
  expect(readProfileModels(location)).toEqual(new Map([['scout', 'a/one']]));
  expect(loadTddConfig(location).config.productionGlobs).toEqual(['lib/**']);
  expect(loadCompactionConfig(location)).toEqual({ reminderTokens: 150_000 });
});
