import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { readBulkReadModel, requireBulkReadModel } from './config.js';

const writeConfig = (path: string, value: unknown) => {
  writeFileSync(path, JSON.stringify(value));
};

const configFixture = (onTestFinished: (callback: () => void) => void) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-bulk-read-config-'));
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

it('reads the bulk_read model from the user file', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  writeConfig(userFile, {
    allowedModels: ['openrouter/meta/llama'],
    bulkRead: { model: 'openrouter/meta/llama' },
  });

  writeConfig(repositoryFile, { tdd: {} });

  expect(readBulkReadModel(location)).toBe('openrouter/meta/llama');
  expect(requireBulkReadModel(location)).toBe('openrouter/meta/llama');
});

it('reads no model without config files or a bulkRead block, and requiring one names the key and file', ({
  onTestFinished,
}) => {
  const { location, userFile } = configFixture(onTestFinished);

  expect(readBulkReadModel(location)).toBeUndefined();

  writeConfig(userFile, { profiles: { default: { model: 'a/default' } } });

  expect(readBulkReadModel(location)).toBeUndefined();

  const require = () => requireBulkReadModel(location);
  expect(require).toThrow('bulkRead.model');
  expect(require).toThrow(userFile);
});

it.for<[string, unknown, string]>([
  ['a non-object block', 'a/model', 'bulkRead'],
  ['an unknown key', { model: 'a/model', thinking: 'high' }, 'bulkRead.thinking'],
  ['a missing model', {}, 'bulkRead.model'],
  ['a malformed model', { model: 'no-provider' }, 'bulkRead.model'],
  ['a non-string model', { model: 5 }, 'bulkRead.model'],
])('refuses %s and names the file and field', ([, bulkRead, field], { onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { bulkRead });

  const read = () => readBulkReadModel(location);

  expect(read).toThrow(userFile);
  expect(read).toThrow(field);
});

it('refuses bulkRead in the repository file and names that file', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  writeConfig(userFile, { bulkRead: { model: 'a/model' } });
  writeConfig(repositoryFile, { bulkRead: { model: 'b/model' } });

  expect(() => readBulkReadModel(location)).toThrow(repositoryFile);
  expect(readBulkReadModel({ ...location, projectTrusted: false })).toBe('a/model');
});
