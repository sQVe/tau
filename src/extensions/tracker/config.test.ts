import { writeFileSync } from 'node:fs';

import { expect, it, vi } from 'vitest';

import { temporaryTauConfig } from '../../../tests/tauConfigHarness.js';
import type { ConfigWarnings } from '../../config/config.js';
import { readTrackerSetup } from './config.js';

const ui = { notify: () => undefined };

it('reads the route of the checkout past case-duplicate entries for another repository', ({
  onTestFinished,
}) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-tracker-config-');

  writeUser({
    tracker: {
      agentTeam: 'AI',
      repositories: {
        'sQVe/cape': { team: 'AB' },
        'sqve/Cape': { team: 'AB' },
        'sQVe/tau': { team: 'ME', project: 'Tau' },
      },
    },
  });

  expect(readTrackerSetup(location, ui, 'sQVe/tau')).toEqual({
    status: 'read',
    agentTeam: 'AI',
    route: { team: 'ME', project: 'Tau' },
  });
});

it.for<[string, [string, unknown][]]>([
  [
    'the valid entry first',
    [
      ['sQVe/tau', { team: 'ME' }],
      ['sqve/Tau', { team: 'OTHER' }],
    ],
  ],
  [
    'the malformed entry first',
    [
      ['sqve/Tau', 'ME'],
      ['sQVe/tau', { team: 'ME' }],
    ],
  ],
])(
  'refuses case-duplicate entries for the current repository with %s',
  ([, entries], { onTestFinished }) => {
    const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-tracker-config-');

    writeUser({ tracker: { repositories: Object.fromEntries(entries) } });

    const setup = readTrackerSetup(location, ui, 'sQVe/tau');

    expect(setup.status === 'invalid' ? setup.message : undefined).toContain('same repository');
  },
);

it('reads the agent team without a warning when the checkout has no repository', ({
  onTestFinished,
}) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-tracker-config-');
  const notify = vi.fn<ConfigWarnings['notify']>();

  writeUser({ tracker: { agentTeam: 'AI', repositories: {} } });

  expect(readTrackerSetup(location, { notify }, undefined)).toEqual({
    status: 'read',
    agentTeam: 'AI',
    route: undefined,
  });

  expect(notify).not.toHaveBeenCalled();
});

it('reads no route for a repository without an entry', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-tracker-config-');

  writeUser({ tracker: { agentTeam: 'AI', repositories: { 'sQVe/cape': { team: 'AB' } } } });

  expect(readTrackerSetup(location, ui, 'sQVe/tau')).toEqual({
    status: 'read',
    agentTeam: 'AI',
    route: undefined,
  });
});

it('reads a route without a project as no project', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-tracker-config-');

  writeUser({ tracker: { agentTeam: 'AI', repositories: { 'sqve/TAU': { team: 'ME' } } } });

  expect(readTrackerSetup(location, ui, 'sQVe/tau')).toEqual({
    status: 'read',
    agentTeam: 'AI',
    route: { team: 'ME', project: undefined },
  });
});

it('fails the setup for a bad entry of the current repository, naming the file and field', ({
  onTestFinished,
}) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-tracker-config-',
  );

  writeUser({ tracker: { repositories: { 'sqve/Tau': { project: 'Tau' } } } });

  const setup = readTrackerSetup(location, ui, 'sQVe/tau');

  expect(setup.status === 'invalid' ? setup.message : undefined).toContain(userFile);

  expect(setup.status === 'invalid' ? setup.message : undefined).toContain(
    'tracker.repositories.sqve/Tau.team',
  );
});

it('skips a bad entry for another repository', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-tracker-config-');

  writeUser({
    tracker: {
      agentTeam: 'AI',
      repositories: {
        'sQVe/tau': { team: 'ME', project: 'Tau' },
        'sQVe/cape': { project: 'Cape' },
        'sQVe/other': 'AB',
      },
    },
  });

  expect(readTrackerSetup(location, ui, 'sQVe/tau')).toEqual({
    status: 'read',
    agentTeam: 'AI',
    route: { team: 'ME', project: 'Tau' },
  });
});

it('reads team keys in upper case, as Linear stores them', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-tracker-config-');

  writeUser({
    tracker: { agentTeam: 'ai', repositories: { 'sQVe/tau': { team: 'me', project: 'Tau' } } },
  });

  expect(readTrackerSetup(location, ui, 'sQVe/tau')).toEqual({
    status: 'read',
    agentTeam: 'AI',
    route: { team: 'ME', project: 'Tau' },
  });
});

it('reads no tracker setup without config files or a tracker block', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-tracker-config-');

  expect(readTrackerSetup(location, ui, 'sQVe/tau')).toEqual({ status: 'unset' });

  writeUser({ profiles: {} });

  expect(readTrackerSetup(location, ui, 'sQVe/tau')).toEqual({ status: 'unset' });
});

it('reads an empty tracker block as no agent team and no route', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-tracker-config-');

  writeUser({ tracker: {} });

  expect(readTrackerSetup(location, ui, 'sQVe/tau')).toEqual({
    status: 'read',
    agentTeam: undefined,
    route: undefined,
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
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-tracker-config-',
  );

  writeUser({ tracker });

  const setup = readTrackerSetup(location, ui, 'sQVe/tau');

  expect(setup.status === 'invalid' ? setup.message : undefined).toContain(userFile);
  expect(setup.status === 'invalid' ? setup.message : undefined).toContain(field);
});

it('refuses the old slice key and names tracker.agentTeam', ({ onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-tracker-config-',
  );

  writeUser({ slice: { agentTeam: 'AI' }, tracker: { agentTeam: 'AI' } });

  const setup = readTrackerSetup(location, ui, 'sQVe/tau');

  expect(setup.status === 'invalid' ? setup.message : undefined).toContain(userFile);
  expect(setup.status === 'invalid' ? setup.message : undefined).toContain('tracker.agentTeam');
});

it('refuses tracker in the repository file and names that file', ({ onTestFinished }) => {
  const { location, repositoryFile, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-tracker-config-',
  );

  writeUser({ tracker: { agentTeam: 'AI' } });
  writeRepository({ tracker: { agentTeam: 'OTHER' } });

  const setup = readTrackerSetup(location, ui, 'sQVe/tau');

  expect(setup.status === 'invalid' ? setup.message : undefined).toContain(repositoryFile);

  expect(readTrackerSetup({ ...location, projectTrusted: false }, ui, 'sQVe/tau')).toEqual({
    status: 'read',
    agentTeam: 'AI',
    route: undefined,
  });
});

it('reports a config file that is not JSON as an invalid setup', ({ onTestFinished }) => {
  const { location, userFile } = temporaryTauConfig(onTestFinished, 'tau-tracker-config-');

  writeFileSync(userFile, '{ "tracker": ');

  const setup = readTrackerSetup(location, ui, 'sQVe/tau');

  expect(setup.status === 'invalid' ? setup.message : undefined).toContain(userFile);
});
