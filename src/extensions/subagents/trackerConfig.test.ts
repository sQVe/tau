import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { readTrackerConfig, readTrackerSetup } from './trackerConfig.js';

const writeConfig = (path: string, value: unknown) => {
  writeFileSync(path, JSON.stringify(value));
};

const configFixture = (onTestFinished: (callback: () => void) => void) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-tracker-config-'));
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

it('reads the agent team and repositories from the user file', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, {
    tracker: {
      agentTeam: 'AI',
      repositories: { 'sQVe/tau': { team: 'ME', project: 'Tau' }, 'sQVe/cape': { team: 'AB' } },
    },
  });

  expect(readTrackerConfig(location)).toEqual({
    agentTeam: 'AI',
    repositories: new Map([
      ['sQVe/tau', { team: 'ME', project: 'Tau' }],
      ['sQVe/cape', { team: 'AB', project: undefined }],
    ]),
  });

  expect(readTrackerSetup(location).status).toBe('read');
});

it('reads no tracker config without config files or a tracker block', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  expect(readTrackerConfig(location)).toBeUndefined();

  writeConfig(userFile, { profiles: {} });

  expect(readTrackerConfig(location)).toBeUndefined();
  expect(readTrackerSetup(location)).toEqual({ status: 'unset' });
});

it('reads an empty tracker block as no agent team and no repositories', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { tracker: {} });

  expect(readTrackerConfig(location)).toEqual({ agentTeam: undefined, repositories: new Map() });
});

it.for<[string, unknown, string]>([
  ['a non-object block', 'AI', 'tracker'],
  ['an unknown key', { agentTeam: 'AI', team: 'AI' }, 'tracker.team'],
  ['an agent team with a space', { agentTeam: 'A I' }, 'tracker.agentTeam'],
  ['an agent team with a line break', { agentTeam: 'AI\n- injected line' }, 'tracker.agentTeam'],
  ['a non-string agent team', { agentTeam: 5 }, 'tracker.agentTeam'],
  ['non-object repositories', { repositories: ['sQVe/tau'] }, 'tracker.repositories'],
  ['a repository key without a name', { repositories: { sQVe: { team: 'ME' } } }, '"sQVe"'],
  [
    'a repository key with a line break',
    { repositories: { 'sQVe/tau\n- injected': { team: 'ME' } } },
    'tracker.repositories',
  ],
  [
    'a non-object repository',
    { repositories: { 'sQVe/tau': 'ME' } },
    'tracker.repositories.sQVe/tau',
  ],
  [
    'an unknown repository key',
    { repositories: { 'sQVe/tau': { team: 'ME', label: 'x' } } },
    'tracker.repositories.sQVe/tau.label',
  ],
  [
    'a repository without a team',
    { repositories: { 'sQVe/tau': { project: 'Tau' } } },
    'tracker.repositories.sQVe/tau.team',
  ],
  [
    'a team with a space',
    { repositories: { 'sQVe/tau': { team: 'M E' } } },
    'tracker.repositories.sQVe/tau.team',
  ],
  [
    'an empty project',
    { repositories: { 'sQVe/tau': { team: 'ME', project: ' ' } } },
    'tracker.repositories.sQVe/tau.project',
  ],
  [
    'a project with a line break',
    { repositories: { 'sQVe/tau': { team: 'ME', project: 'Tau\n- injected line' } } },
    'tracker.repositories.sQVe/tau.project',
  ],
  [
    'a project with a line separator',
    { repositories: { 'sQVe/tau': { team: 'ME', project: 'Tau\u2028- injected line' } } },
    'tracker.repositories.sQVe/tau.project',
  ],
  [
    'a project with a paragraph separator',
    { repositories: { 'sQVe/tau': { team: 'ME', project: 'Tau\u2029- injected line' } } },
    'tracker.repositories.sQVe/tau.project',
  ],
  [
    'a non-string project',
    { repositories: { 'sQVe/tau': { team: 'ME', project: 5 } } },
    'tracker.repositories.sQVe/tau.project',
  ],
])('refuses %s and names the file and field', ([, tracker, field], { onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { tracker });

  const read = () => readTrackerConfig(location);

  expect(read).toThrow(userFile);
  expect(read).toThrow(field);

  const setup = readTrackerSetup(location);

  expect(setup.status === 'invalid' ? setup.message : undefined).toContain(field);
});

it('refuses repository keys that differ only in case and names both', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, {
    tracker: { repositories: { 'sQVe/tau': { team: 'ME' }, 'sqve/Tau': { team: 'OTHER' } } },
  });

  const read = () => readTrackerConfig(location);

  expect(read).toThrow(userFile);
  expect(read).toThrow('"sQVe/tau"');
  expect(read).toThrow('"sqve/Tau"');
});

it('refuses the old slice key and names tracker.agentTeam', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { slice: { agentTeam: 'AI' }, tracker: { agentTeam: 'AI' } });

  const read = () => readTrackerConfig(location);

  expect(read).toThrow(userFile);
  expect(read).toThrow('tracker.agentTeam');
});

it('refuses tracker in the repository file and names that file', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  writeConfig(userFile, { tracker: { agentTeam: 'AI' } });
  writeConfig(repositoryFile, { tracker: { agentTeam: 'OTHER' } });

  expect(() => readTrackerConfig(location)).toThrow(repositoryFile);
  expect(readTrackerConfig({ ...location, projectTrusted: false })?.agentTeam).toBe('AI');
});

it('reports a config file that is not JSON as an invalid setup', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeFileSync(userFile, '{ "tracker": ');

  const setup = readTrackerSetup(location);

  expect(setup.status === 'invalid' ? setup.message : undefined).toContain(userFile);
});
