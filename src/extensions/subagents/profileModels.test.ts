import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { readAllowedModels } from '../../config/models.js';
import { readProfileModel, readProfileModels, readProfileRoute } from './profileModels.js';

const uiFixture = () => ({ notify: vi.fn<(message: string, level?: string) => void>() });

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

  expect(readProfileModels(location, uiFixture())).toEqual(
    new Map([
      ['scout', 'a/scout'],
      ['default', 'openrouter/meta/llama'],
    ]),
  );
});

it('reads no profile models without config files or a profiles block', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  expect(readProfileModels(location, uiFixture())).toEqual(new Map());

  writeConfig(userFile, { allowedModels: ['a/one'] });
  writeConfig(repositoryFile, { tdd: {} });

  expect(readProfileModels(location, uiFixture())).toEqual(new Map());
});

it.for<[string, unknown, string]>([
  ['a non-object profiles block', ['scout'], 'profiles'],
  ['a non-object entry', { scout: 'a/scout' }, 'profiles.scout'],
  ['a missing model', { default: {} }, 'profiles.default.model'],
  ['a malformed model', { scout: { model: 'no-provider' } }, 'profiles.scout.model'],
  ['a non-string model', { scout: { model: 5 } }, 'profiles.scout.model'],
])('refuses %s and names the file and field', ([, profiles, field], { onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { profiles });

  const name = field.split('.')[1] ?? 'scout';
  const read = () => readProfileModel(location, name, uiFixture());

  expect(read).toThrow(userFile);
  expect(read).toThrow(field);
});

it('refuses profiles in the repository file and names that file', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  writeConfig(userFile, { profiles: { scout: { model: 'a/scout' } } });
  writeConfig(repositoryFile, { profiles: {} });

  expect(() => readProfileModels(location, uiFixture())).toThrow(repositoryFile);
  expect(() => readProfileModel(location, 'scout', uiFixture())).toThrow(repositoryFile);

  expect(readProfileModels({ ...location, projectTrusted: false }, uiFixture())).toEqual(
    new Map([['scout', 'a/scout']]),
  );
});

it('leaves allowed models readable when profiles are broken', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile } = configFixture(onTestFinished);

  writeConfig(userFile, { allowedModels: ['a/one'], profiles: { scout: 'broken' } });
  writeConfig(repositoryFile, { profiles: {} });

  expect(() => readProfileModels(location, uiFixture())).toThrow('profiles');
  expect(readAllowedModels(location)?.models).toEqual(['a/one']);
});

const scoutRoute = {
  classifier: 'a/router',
  question: 'How wide is this scout brief?',
  labels: {
    narrow: { criterion: 'A lookup about known code.', model: 'a/small' },
    wide: { criterion: 'An investigation across many files.', model: 'a/scout' },
  },
};

it('reads a profile route and keeps the profile model', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, {
    profiles: { scout: { model: 'a/scout', route: scoutRoute }, plain: { model: 'a/plain' } },
  });

  expect(readProfileModels(location, uiFixture())).toEqual(
    new Map([
      ['scout', 'a/scout'],
      ['plain', 'a/plain'],
    ]),
  );

  expect(readProfileRoute(location, 'scout', uiFixture())).toEqual({
    classifier: scoutRoute.classifier,
    question: scoutRoute.question,
    labels: new Map(Object.entries(scoutRoute.labels)),
    canary: 0,
  });

  expect(readProfileRoute(location, 'plain', uiFixture())).toBeUndefined();
});

it.for<[number, number]>([
  [0, 0],
  [0.25, 0.25],
  [1, 1],
])('reads a route canary of %s', ([canary, expected], { onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, {
    profiles: { scout: { model: 'a/scout', route: { ...scoutRoute, canary } } },
  });

  expect(readProfileRoute(location, 'scout', uiFixture())?.canary).toBe(expected);
});

it.for<[string, unknown, string]>([
  ['a text canary', { ...scoutRoute, canary: '0.5' }, 'must be a number from 0 to 1'],
  ['a null canary', { ...scoutRoute, canary: null }, 'must be a number from 0 to 1'],
  ['a canary above 1', { ...scoutRoute, canary: 1.5 }, 'outside the range 0 to 1'],
  ['a negative canary', { ...scoutRoute, canary: -0.1 }, 'outside the range 0 to 1'],
])('turns routing off for %s with its own message', ([, routes, message], { onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { profiles: { scout: { model: 'a/scout', route: routes } } });

  const ui = uiFixture();

  expect(readProfileRoute(location, 'scout', ui)).toBeUndefined();
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(userFile), 'error');

  expect(ui.notify).toHaveBeenCalledWith(
    expect.stringContaining('profiles.scout.route.canary'),
    'error',
  );

  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(message), 'error');
});

it.for<[string, unknown, string]>([
  [
    'a route with one label',
    { ...scoutRoute, labels: { narrow: scoutRoute.labels.narrow } },
    'profiles.scout.route.labels',
  ],
  [
    'a bad label model',
    {
      ...scoutRoute,
      labels: { ...scoutRoute.labels, wide: { criterion: 'c', model: 'no-provider' } },
    },
    'profiles.scout.route.labels.wide.model',
  ],
  [
    'a missing question',
    { classifier: scoutRoute.classifier, labels: scoutRoute.labels },
    'profiles.scout.route.question',
  ],
  [
    'an empty label name',
    { ...scoutRoute, labels: { narrow: scoutRoute.labels.narrow, '': scoutRoute.labels.wide } },
    'profiles.scout.route.labels',
  ],
  [
    'a blank label name',
    { ...scoutRoute, labels: { narrow: scoutRoute.labels.narrow, ' ': scoutRoute.labels.wide } },
    'profiles.scout.route.labels',
  ],
])(
  'turns routing off for %s and names the file and field',
  ([, routes, field], { onTestFinished }) => {
    const { location, userFile } = configFixture(onTestFinished);

    writeConfig(userFile, { profiles: { scout: { model: 'a/scout', route: routes } } });

    const ui = uiFixture();

    expect(readProfileRoute(location, 'scout', ui)).toBeUndefined();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(userFile), 'error');
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(field), 'error');
    expect(readProfileModel(location, 'scout', ui)).toBe('a/scout');
  },
);

it.for<[string, unknown, string]>([
  ['a route without classifier', { ...scoutRoute, classifier: undefined }, 'route.classifier'],
  ['a malformed classifier', { ...scoutRoute, classifier: 'router' }, 'route.classifier'],
])('turns routing off for %s and names the field', ([, route, field], { onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { profiles: { scout: { model: 'a/scout', route } } });

  const ui = uiFixture();

  expect(readProfileRoute(location, 'scout', ui)).toBeUndefined();
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(field), 'error');
  expect(readProfileModel(location, 'scout', ui)).toBe('a/scout');
});

it('turns routing off for a profile that still sets routes and names the edit', ({
  onTestFinished,
}) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { profiles: { scout: { model: 'a/scout', routes: scoutRoute } } });

  const ui = uiFixture();

  expect(readProfileRoute(location, 'scout', ui)).toBeUndefined();

  const messages = ui.notify.mock.calls.map(([message]) => message);

  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('profiles.scout.routes');
  expect(messages[0]).toContain('profiles.scout.route');
  expect(messages[0]).toContain('route.classifier');
  expect(ui.notify).toHaveBeenCalledWith(expect.any(String), 'error');
  expect(readProfileModel(location, 'scout', ui)).toBe('a/scout');
});

it('reads a profile with unknown keys at any depth and reports each key path once per session', ({
  onTestFinished,
}) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, {
    profiles: {
      worker: {
        model: 'a/worker',
        futureKey: true,
        route: {
          ...scoutRoute,
          later: 1,
          labels: { ...scoutRoute.labels, wide: { ...scoutRoute.labels.wide, speed: 2 } },
        },
      },
    },
  });

  const ui = uiFixture();

  expect(readProfileModel(location, 'worker', ui)).toBe('a/worker');
  expect(readProfileRoute(location, 'worker', ui)?.canary).toBe(0);
  expect(readProfileModel(location, 'worker', ui)).toBe('a/worker');

  const warnings = ui.notify.mock.calls.map(([message, level]) => ({ message, level }));

  expect(warnings).toHaveLength(3);
  expect(warnings.every(({ level }) => level === 'warning')).toBe(true);

  for (const keyPath of [
    'profiles.worker.futureKey',
    'profiles.worker.route.later',
    'profiles.worker.route.labels.wide.speed',
  ]) {
    expect(
      warnings.filter(({ message }) => message.includes(`${userFile}: ${keyPath} `)),
    ).toHaveLength(1);
  }

  const nextSession = uiFixture();
  readProfileModel(location, 'worker', nextSession);

  expect(nextSession.notify).toHaveBeenCalledTimes(3);
});

it('fails only the profile whose entry is bad', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, {
    profiles: { scout: { model: 5 }, worker: { model: 'a/worker' }, other: { routes: {} } },
  });

  expect(() => readProfileModel(location, 'scout', uiFixture())).toThrow('profiles.scout.model');
  expect(readProfileModel(location, 'worker', uiFixture())).toBe('a/worker');
  expect(() => readProfileModel(location, 'other', uiFixture())).toThrow('profiles.other.model');
  expect(readProfileModels(location, uiFixture())).toEqual(new Map([['worker', 'a/worker']]));
});

it.for<[string, string]>([
  ['a profile with no entry', 'missing'],
  ['a profile entry with no route', 'plain'],
])('reads no route and raises no notice for %s', ([, name], { onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { profiles: { plain: { model: 'a/plain' } } });

  const ui = uiFixture();

  expect(readProfileRoute(location, name, ui)).toBeUndefined();
  expect(ui.notify).not.toHaveBeenCalled();
});

it.for<[string, unknown, string]>([
  ['a numeric question', { ...scoutRoute, question: 5 }, 'route.question'],
  ['an empty question', { ...scoutRoute, question: '' }, 'route.question'],
  ['a blank question', { ...scoutRoute, question: '  \n' }, 'route.question'],
  [
    'a blank label criterion',
    {
      ...scoutRoute,
      labels: { ...scoutRoute.labels, wide: { criterion: ' ', model: 'a/scout' } },
    },
    'route.labels.wide.criterion',
  ],
  ['labels as a list', { ...scoutRoute, labels: Object.values(scoutRoute.labels) }, 'route.labels'],
])('turns routing off for %s and names the field', ([, route, field], { onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { profiles: { scout: { model: 'a/scout', route } } });

  const ui = uiFixture();

  expect(readProfileRoute(location, 'scout', ui)).toBeUndefined();
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(field), 'error');
});

it('refuses a profile model that is not a string', ({ onTestFinished }) => {
  const { location, userFile } = configFixture(onTestFinished);

  writeConfig(userFile, { profiles: { scout: { model: ['a/scout'] } } });

  expect(() => readProfileModel(location, 'scout', uiFixture())).toThrow('profiles.scout.model');
});
