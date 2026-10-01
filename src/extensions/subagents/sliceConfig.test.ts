import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { readSliceAgentTeam } from './sliceConfig.js';

const writeConfig = (path: string, value: unknown) => {
  writeFileSync(path, JSON.stringify(value));
};

const configFixture = (onTestFinished: (callback: () => void) => void) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-slice-config-'));
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

it('reads the agent team from the user file', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { slice: { agentTeam: 'AI' } });

  expect(readSliceAgentTeam(location)).toBe('AI');
});

it('reads no agent team without config files, a slice block, or an agentTeam key', ({
  onTestFinished,
}) => {
  const { location, userFile } = configFixture(onTestFinished);

  expect(readSliceAgentTeam(location)).toBeUndefined();

  writeConfig(userFile, { profiles: {} });

  expect(readSliceAgentTeam(location)).toBeUndefined();

  writeConfig(userFile, { slice: {} });

  expect(readSliceAgentTeam(location)).toBeUndefined();
});

it.for<[string, unknown, string]>([
  ['a non-object block', 'AI', 'slice'],
  ['an unknown key', { agentTeam: 'AI', team: 'AI' }, 'slice.team'],
  ['an empty team', { agentTeam: ' ' }, 'slice.agentTeam'],
  ['a team with a line break', { agentTeam: 'AI\n- injected line' }, 'slice.agentTeam'],
  ['a non-string team', { agentTeam: 5 }, 'slice.agentTeam'],
])('refuses %s and names the file and field', ([, slice, field], { onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { slice });

  const read = () => readSliceAgentTeam(location);

  expect(read).toThrow(userFile);
  expect(read).toThrow(field);
});

it('refuses slice in the repository file and names that file', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  writeConfig(userFile, { slice: { agentTeam: 'AI' } });
  writeConfig(repositoryFile, { slice: { agentTeam: 'OTHER' } });

  expect(() => readSliceAgentTeam(location)).toThrow(repositoryFile);
  expect(readSliceAgentTeam({ ...location, projectTrusted: false })).toBe('AI');
});
