import { expect, it, vi } from 'vitest';

import { temporaryTauConfig } from '../../../tests/tauConfigHarness.js';
import { readAllowedModels } from '../../config/models.js';
import { readProfileModel, readProfileModels, readProfileThinking } from './profileModels.js';

const uiFixture = () => ({ notify: vi.fn<(message: string, level?: string) => void>() });

it('reads profile models from the user file', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-profile-models-');

  writeUser({
    allowedModels: ['a/one'],
    profiles: { scout: { model: 'a/scout' }, default: { model: 'openrouter/meta/llama' } },
  });

  expect(readProfileModels(location, uiFixture())).toEqual(
    new Map([
      ['scout', 'a/scout'],
      ['default', 'openrouter/meta/llama'],
    ]),
  );
});

it('an unknown route key warns and is ignored', ({ onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-profile-models-',
  );

  writeUser({
    profiles: {
      scout: {
        model: 'a/scout',
        route: { classifier: 'a/router', question: 'How wide?', labels: {} },
      },
    },
  });

  const ui = uiFixture();

  expect(readProfileModel(location, 'scout', ui)).toBe('a/scout');

  expect(ui.notify).toHaveBeenCalledWith(
    expect.stringContaining(`${userFile}: profiles.scout.route `),
    'warning',
  );
});

it('reads no profile models without config files or a profiles block', ({ onTestFinished }) => {
  const { location, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-profile-models-',
  );

  expect(readProfileModels(location, uiFixture())).toEqual(new Map());

  writeUser({ allowedModels: ['a/one'] });
  writeRepository({ tdd: {} });

  expect(readProfileModels(location, uiFixture())).toEqual(new Map());
});

it.for<[string, unknown, string]>([
  ['a non-object profiles block', ['scout'], 'profiles'],
  ['a non-object entry', { scout: 'a/scout' }, 'profiles.scout'],
  ['a missing model', { default: {} }, 'profiles.default.model'],
  ['a malformed model', { scout: { model: 'no-provider' } }, 'profiles.scout.model'],
  ['a non-string model', { scout: { model: 5 } }, 'profiles.scout.model'],
])('refuses %s and names the file and field', ([, profiles, field], { onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-profile-models-',
  );

  writeUser({ profiles });

  const name = field.split('.')[1] ?? 'scout';
  const read = () => readProfileModel(location, name, uiFixture());

  expect(read).toThrow(userFile);
  expect(read).toThrow(field);
});

it('refuses profiles in the repository file and names that file', ({ onTestFinished }) => {
  const { location, repositoryFile, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-profile-models-',
  );

  writeUser({ profiles: { scout: { model: 'a/scout' } } });
  writeRepository({ profiles: {} });

  expect(() => readProfileModels(location, uiFixture())).toThrow(repositoryFile);
  expect(() => readProfileModel(location, 'scout', uiFixture())).toThrow(repositoryFile);

  expect(readProfileModels({ ...location, projectTrusted: false }, uiFixture())).toEqual(
    new Map([['scout', 'a/scout']]),
  );
});

it('leaves allowed models readable when profiles are broken', ({ onTestFinished }) => {
  const { location, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-profile-models-',
  );

  writeUser({ allowedModels: ['a/one'], profiles: { scout: 'broken' } });
  writeRepository({ profiles: {} });

  expect(() => readProfileModels(location, uiFixture())).toThrow('profiles');
  expect(readAllowedModels(location)?.models).toEqual(['a/one']);
});

it('fails only the profile whose entry is bad', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-profile-models-');

  writeUser({
    profiles: { scout: { model: 5 }, worker: { model: 'a/worker' }, other: { routes: {} } },
  });

  expect(() => readProfileModel(location, 'scout', uiFixture())).toThrow('profiles.scout.model');
  expect(readProfileModel(location, 'worker', uiFixture())).toBe('a/worker');
  expect(() => readProfileModel(location, 'other', uiFixture())).toThrow('profiles.other.model');
  expect(readProfileModels(location, uiFixture())).toEqual(new Map([['worker', 'a/worker']]));
});

it('refuses a profile model that is not a string', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-profile-models-');

  writeUser({ profiles: { scout: { model: ['a/scout'] } } });

  expect(() => readProfileModel(location, 'scout', uiFixture())).toThrow('profiles.scout.model');
});

it('reads a profile thinking level and leaves an absent one undefined', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-profile-models-');

  writeUser({
    profiles: { scout: { model: 'a/scout', thinking: 'high' }, plain: { model: 'a/plain' } },
  });

  expect(readProfileThinking(location, 'scout', uiFixture())).toBe('high');
  expect(readProfileThinking(location, 'plain', uiFixture())).toBeUndefined();
  expect(readProfileThinking(location, 'missing', uiFixture())).toBeUndefined();
});

it('refuses an invalid profile thinking and names the field', ({ onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-profile-models-',
  );

  writeUser({ profiles: { scout: { model: 'a/scout', thinking: 'bogus' } } });

  const read = () => readProfileThinking(location, 'scout', uiFixture());

  expect(read).toThrow(userFile);
  expect(read).toThrow('profiles.scout.thinking');
});

it('refuses a profile thinking that is not a string and names the field', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-profile-models-');

  writeUser({ profiles: { scout: { model: 'a/scout', thinking: 5 } } });

  expect(() => readProfileThinking(location, 'scout', uiFixture())).toThrow(
    'profiles.scout.thinking',
  );
});
