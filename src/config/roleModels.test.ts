import { expect, it, vi } from 'vitest';

import { temporaryTauConfig } from '../../tests/tauConfigHarness.js';
import { readRoleModel, readRoleProfileModel, roleModelKinds } from './roleModels.js';

const uiFixture = () => ({ notify: vi.fn<(message: string, level?: string) => void>() });

it('reads role and role profile models in kind order', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-role-models-');

  writeUser({
    roles: {
      lead: { model: 'a/lead', profiles: { scout: { model: 'a/scout' } } },
      architect: { model: 'a/architect' },
    },
  });

  expect(roleModelKinds).toEqual(['lead', 'architect']);
  expect(readRoleModel(location, 'lead', uiFixture())).toBe('a/lead');
  expect(readRoleModel(location, 'architect', uiFixture())).toBe('a/architect');
  expect(readRoleProfileModel(location, 'lead', 'scout', uiFixture())).toBe('a/scout');
  expect(readRoleProfileModel(location, 'lead', 'reviewer', uiFixture())).toBeUndefined();
});

it('returns no role model for a worker or a missing entry', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-role-models-');

  expect(readRoleModel(location, 'worker', uiFixture())).toBeUndefined();
  expect(readRoleProfileModel(location, 'worker', 'scout', uiFixture())).toBeUndefined();
  expect(readRoleModel(location, 'lead', uiFixture())).toBeUndefined();

  writeUser({ roles: { lead: {}, architect: {} } });

  expect(readRoleModel(location, 'lead', uiFixture())).toBeUndefined();
  expect(readRoleProfileModel(location, 'lead', 'scout', uiFixture())).toBeUndefined();
});

it('returns no role profile model for an existing entry without a model', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-role-models-');

  writeUser({ roles: { lead: { profiles: { scout: {} } } } });

  expect(readRoleProfileModel(location, 'lead', 'scout', uiFixture())).toBeUndefined();
});

it('warns about an unknown role name and keeps an unknown profile override silently', ({
  onTestFinished,
}) => {
  const { location, userFile, writeUser } = temporaryTauConfig(onTestFinished, 'tau-role-models-');

  writeUser({
    roles: {
      lead: { model: 'a/lead', profiles: { unknown: { model: 'a/unknown' } } },
      manager: { model: 'a/manager' },
    },
  });

  const ui = uiFixture();

  expect(readRoleModel(location, 'lead', ui)).toBe('a/lead');
  expect(readRoleProfileModel(location, 'lead', 'unknown', ui)).toBe('a/unknown');

  expect(ui.notify).toHaveBeenCalledWith(
    expect.stringContaining(`${userFile}: roles.manager `),
    'warning',
  );

  expect(ui.notify).toHaveBeenCalledTimes(1);
});

it('an invalid roles entry fails only that role', ({ onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(onTestFinished, 'tau-role-models-');

  writeUser({
    roles: {
      lead: { model: 'a/lead', profiles: { scout: { model: 'a/scout' } } },
      architect: { model: 'no-provider' },
    },
  });

  expect(readRoleModel(location, 'lead', uiFixture())).toBe('a/lead');
  expect(readRoleProfileModel(location, 'lead', 'scout', uiFixture())).toBe('a/scout');

  const readArchitect = () => readRoleModel(location, 'architect', uiFixture());

  expect(readArchitect).toThrow(userFile);
  expect(readArchitect).toThrow('roles.architect.model');
  expect(readArchitect).toThrow('is not provider/model-id');
});

it.for<[string, unknown, string]>([
  ['a non-object roles block', ['lead'], 'roles'],
  ['a non-object role entry', { lead: 'a/lead' }, 'roles.lead'],
  ['a non-string model', { lead: { model: 5 } }, 'roles.lead.model'],
])('refuses %s and names the file and field', ([, roles, field], { onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(onTestFinished, 'tau-role-models-');

  writeUser({ roles });

  const read = () => readRoleModel(location, 'lead', uiFixture());

  expect(read).toThrow(userFile);
  expect(read).toThrow(field);
});

it.for<[string, unknown, string]>([
  ['a non-object profiles block', { profiles: ['scout'] }, 'roles.lead.profiles'],
  ['a non-object profile entry', { profiles: { scout: 'a/scout' } }, 'roles.lead.profiles.scout'],
  [
    'a malformed profile model',
    { profiles: { scout: { model: 'no-provider' } } },
    'roles.lead.profiles.scout.model',
  ],
])('refuses %s and names the file and field', ([, lead, field], { onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(onTestFinished, 'tau-role-models-');

  writeUser({ roles: { lead } });

  const read = () => readRoleProfileModel(location, 'lead', 'scout', uiFixture());

  expect(read).toThrow(userFile);
  expect(read).toThrow(field);
});

it('refuses roles in the repository file and names that file', ({ onTestFinished }) => {
  const { location, repositoryFile, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-role-models-',
  );

  writeUser({ roles: { lead: { model: 'a/lead' } } });
  writeRepository({ roles: {} });

  expect(() => readRoleModel(location, 'lead', uiFixture())).toThrow(repositoryFile);

  expect(readRoleModel({ ...location, projectTrusted: false }, 'lead', uiFixture())).toBe('a/lead');
});
