import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import type { ConfigWarnings } from '../../tauConfig.js';
import { readTrackerConfig, readTrackerSetup } from './trackerConfig.js';

const ui = { notify: () => undefined };

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

  expect(readTrackerConfig(location, ui, 'sQVe/tau')).toEqual({
    agentTeam: 'AI',
    repositories: new Map([
      ['sQVe/tau', { team: 'ME', project: 'Tau' }],
      ['sQVe/cape', { team: 'AB', project: undefined }],
    ]),
  });

  expect(readTrackerSetup(location, ui, 'sQVe/tau').status).toBe('read');
});

it('reads past unknown keys and reports each key path once', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);
  const notify = vi.fn<ConfigWarnings['notify']>();

  writeConfig(userFile, {
    tracker: {
      futureKey: 1,
      repositories: { 'sQVe/tau': { team: 'ME', project: 'Tau', futureKey: 2 } },
    },
  });

  const sessionUi = { notify };
  const read = () => readTrackerConfig(location, sessionUi, 'sQVe/tau');

  expect(read()?.repositories.get('sQVe/tau')).toEqual({ team: 'ME', project: 'Tau' });

  read();

  const messages = notify.mock.calls.map(([message]) => message);

  expect(messages).toHaveLength(2);
  expect(messages.join('\n')).toContain('tracker.futureKey');
  expect(messages.join('\n')).toContain('tracker.repositories.sQVe/tau.futureKey');
  expect(notify.mock.calls.every(([, level]) => level === 'warning')).toBe(true);
});

it.for<[string, unknown]>([
  ['a repository key without a name', { sQVe: { team: 'ME' } }],
  ['a repository key with a line break', { 'sQVe/tau\n- injected': { team: 'ME' } }],
  ['a non-object entry', { 'sQVe/cape': 'AB' }],
  ['an entry without a team', { 'sQVe/cape': { project: 'Cape' } }],
])(
  'keeps the current repository routed past %s for another one',
  ([, other], { onTestFinished }) => {
    const { location, userFile } = configFixture(onTestFinished);

    writeConfig(userFile, {
      tracker: {
        agentTeam: 'AI',
        repositories: { 'sQVe/tau': { team: 'ME' }, ...(other as object) },
      },
    });

    const setup = readTrackerSetup(location, ui, 'sQVe/tau');

    expect(setup).toEqual({
      status: 'read',
      config: {
        agentTeam: 'AI',
        repositories: new Map([['sQVe/tau', { team: 'ME', project: undefined }]]),
      },
    });
  },
);

it('fails the setup for a bad entry of the current repository, naming the file and field', ({
  onTestFinished,
}) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { tracker: { repositories: { 'sqve/Tau': { project: 'Tau' } } } });

  const setup = readTrackerSetup(location, ui, 'sQVe/tau');

  expect(setup.status === 'invalid' ? setup.message : undefined).toContain(userFile);

  expect(setup.status === 'invalid' ? setup.message : undefined).toContain(
    'tracker.repositories.sqve/Tau.team',
  );
});

it('reads team keys in upper case, as Linear stores them', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, {
    tracker: { agentTeam: 'ai', repositories: { 'sQVe/tau': { team: 'me', project: 'Tau' } } },
  });

  expect(readTrackerConfig(location, ui, 'sQVe/tau')).toEqual({
    agentTeam: 'AI',
    repositories: new Map([['sQVe/tau', { team: 'ME', project: 'Tau' }]]),
  });
});

it('reads no tracker config without config files or a tracker block', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  expect(readTrackerConfig(location, ui, 'sQVe/tau')).toBeUndefined();

  writeConfig(userFile, { profiles: {} });

  expect(readTrackerConfig(location, ui, 'sQVe/tau')).toBeUndefined();
  expect(readTrackerSetup(location, ui, 'sQVe/tau')).toEqual({ status: 'unset' });
});

it('reads an empty tracker block as no agent team and no repositories', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { tracker: {} });

  expect(readTrackerConfig(location, ui, 'sQVe/tau')).toEqual({
    agentTeam: undefined,
    repositories: new Map(),
  });
});

it.for<[string, unknown, string]>([
  ['a non-object block', 'AI', 'tracker'],
  ['an agent team with a space', { agentTeam: 'A I' }, 'tracker.agentTeam'],
  ['an agent team with a line break', { agentTeam: 'AI\n- injected line' }, 'tracker.agentTeam'],
  ['a non-string agent team', { agentTeam: 5 }, 'tracker.agentTeam'],
  ['non-object repositories', { repositories: ['sQVe/tau'] }, 'tracker.repositories'],
  [
    'a non-object repository',
    { repositories: { 'sQVe/tau': 'ME' } },
    'tracker.repositories.sQVe/tau',
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

  const read = () => readTrackerConfig(location, ui, 'sQVe/tau');

  expect(read).toThrow(userFile);
  expect(read).toThrow(field);

  const setup = readTrackerSetup(location, ui, 'sQVe/tau');

  expect(setup.status === 'invalid' ? setup.message : undefined).toContain(field);
});

it('refuses repository keys that differ only in case and names both', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, {
    tracker: { repositories: { 'sQVe/tau': { team: 'ME' }, 'sqve/Tau': { team: 'OTHER' } } },
  });

  const read = () => readTrackerConfig(location, ui, 'sQVe/tau');

  expect(read).toThrow(userFile);
  expect(read).toThrow('"sQVe/tau"');
  expect(read).toThrow('"sqve/Tau"');
});

it('refuses the old slice key and names tracker.agentTeam', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { slice: { agentTeam: 'AI' }, tracker: { agentTeam: 'AI' } });

  const read = () => readTrackerConfig(location, ui, 'sQVe/tau');

  expect(read).toThrow(userFile);
  expect(read).toThrow('tracker.agentTeam');
});

it('refuses tracker in the repository file and names that file', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  writeConfig(userFile, { tracker: { agentTeam: 'AI' } });
  writeConfig(repositoryFile, { tracker: { agentTeam: 'OTHER' } });

  expect(() => readTrackerConfig(location, ui, 'sQVe/tau')).toThrow(repositoryFile);

  expect(readTrackerConfig({ ...location, projectTrusted: false }, ui, 'sQVe/tau')?.agentTeam).toBe(
    'AI',
  );
});

it('reports a config file that is not JSON as an invalid setup', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeFileSync(userFile, '{ "tracker": ');

  const setup = readTrackerSetup(location, ui, 'sQVe/tau');

  expect(setup.status === 'invalid' ? setup.message : undefined).toContain(userFile);
});
