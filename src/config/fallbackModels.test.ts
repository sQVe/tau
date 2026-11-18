import { writeFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { temporaryTauConfig } from '../../tests/tauConfigHarness.js';
import { readFallbackModels } from './fallbackModels.js';

const validModel = { primary: 'a/primary', fallback: 'b/fallback', fallbackAtRetry: 5 };

const readUser = (location: Parameters<typeof readFallbackModels>[0]) =>
  readFallbackModels({ ...location, projectTrusted: false });

it('reads a valid user entry', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-fallback-models-');

  writeUser({ fallbackModels: { 'deepseek-flash': validModel } });

  expect(readUser(location)).toEqual({
    models: [
      {
        name: 'deepseek-flash',
        primary: 'a/primary',
        fallback: 'b/fallback',
        fallbackAtRetry: 5,
      },
    ],
    problems: [],
  });
});

it('returns nothing without the key', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-fallback-models-');

  expect(readUser(location)).toEqual({ models: [], problems: [] });

  writeUser({ browser: {} });

  expect(readUser(location)).toEqual({ models: [], problems: [] });
});

it('ignores the repository file', ({ onTestFinished }) => {
  const { location, writeRepository } = temporaryTauConfig(onTestFinished, 'tau-fallback-models-');

  writeRepository({ fallbackModels: { 'deepseek-flash': validModel } });

  expect(readUser(location)).toEqual({ models: [], problems: [] });
});

it('reports a malformed file', ({ onTestFinished }) => {
  const { location, userFile } = temporaryTauConfig(onTestFinished, 'tau-fallback-models-');

  writeFileSync(userFile, '{');

  const { models, problems } = readUser(location);

  expect(models).toEqual([]);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain(userFile);
});

it('reports a non-object fallbackModels and returns no models', ({ onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-fallback-models-',
  );

  writeUser({ fallbackModels: [] });

  expect(readUser(location)).toEqual({
    models: [],
    problems: [
      `Invalid Tau config ${userFile}: fallbackModels must be an object that maps names to {"primary", "fallback", "fallbackAtRetry"}.`,
    ],
  });
});

it.for<[string, Record<string, unknown>, string]>([
  [
    'a name that is not lower-case',
    { Deep_Flash: validModel },
    'fallbackModels.Deep_Flash must use lower-case letters, digits, and hyphens.',
  ],
  ['an entry that is not an object', { bad: 'a/primary' }, 'fallbackModels.bad must be an object.'],
  [
    'a primary that is not provider/model-id',
    { bad: { ...validModel, primary: 'no-provider' } },
    'fallbackModels.bad.primary "no-provider" is not provider/model-id.',
  ],
  [
    'a fallback that is not provider/model-id',
    { bad: { ...validModel, fallback: 5 } },
    'fallbackModels.bad.fallback 5 is not provider/model-id.',
  ],
  [
    'the same model as primary and fallback',
    { bad: { ...validModel, fallback: 'a/primary' } },
    'fallbackModels.bad names the same model as primary and fallback.',
  ],
  [
    'a fallbackAtRetry that is not a whole number of at least 1',
    { bad: { ...validModel, fallbackAtRetry: 0 } },
    'fallbackModels.bad.fallbackAtRetry 0 must be a whole number of at least 1.',
  ],
])('reports %s and keeps the other entry', ([, bad, message], { onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-fallback-models-',
  );

  writeUser({ fallbackModels: { 'deepseek-flash': validModel, ...bad } });

  expect(readUser(location)).toEqual({
    models: [
      {
        name: 'deepseek-flash',
        primary: 'a/primary',
        fallback: 'b/fallback',
        fallbackAtRetry: 5,
      },
    ],
    problems: [`Invalid Tau config ${userFile}: ${message}`],
  });
});

it('reports an unknown key and keeps the entry', ({ onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-fallback-models-',
  );

  writeUser({ fallbackModels: { bad: { ...validModel, extra: true } } });

  expect(readUser(location)).toEqual({
    models: [
      {
        name: 'bad',
        primary: 'a/primary',
        fallback: 'b/fallback',
        fallbackAtRetry: 5,
      },
    ],
    problems: [`Invalid Tau config ${userFile}: fallbackModels.bad has unknown key extra.`],
  });
});
