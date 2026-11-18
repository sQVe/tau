import { writeFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { temporaryTauConfig } from '../../../tests/tauConfigHarness.js';
import { readFallbackModels } from './fallbackConfig.js';

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
    warnings: [],
  });
});

it('returns nothing without the key', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-fallback-models-');

  expect(readUser(location)).toEqual({ models: [], problems: [], warnings: [] });

  writeUser({ browser: {} });

  expect(readUser(location)).toEqual({ models: [], problems: [], warnings: [] });
});

it('ignores the repository file', ({ onTestFinished }) => {
  const { location, writeRepository } = temporaryTauConfig(onTestFinished, 'tau-fallback-models-');

  writeRepository({ fallbackModels: { 'deepseek-flash': validModel } });

  expect(readUser(location)).toEqual({ models: [], problems: [], warnings: [] });
});

it('reports a malformed file', ({ onTestFinished }) => {
  const { location, userFile } = temporaryTauConfig(onTestFinished, 'tau-fallback-models-');

  writeFileSync(userFile, '{');

  const { models, problems, warnings } = readUser(location);

  expect(models).toEqual([]);
  expect(warnings).toEqual([]);
  expect(problems).toHaveLength(1);
  expect(problems[0]?.startsWith(`Invalid Tau config ${userFile}: not valid JSON (`)).toBe(true);
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
    warnings: [],
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
  [
    'a primary that is not a string',
    { bad: { ...validModel, primary: ['a/primary'] } },
    'fallbackModels.bad.primary ["a/primary"] is not provider/model-id.',
  ],
  [
    'a fallbackAtRetry that is not a number',
    { bad: { ...validModel, fallbackAtRetry: '5' } },
    'fallbackModels.bad.fallbackAtRetry "5" must be a whole number of at least 1.',
  ],
  [
    'a fallbackAtRetry that is not an integer',
    { bad: { ...validModel, fallbackAtRetry: 1.5 } },
    'fallbackModels.bad.fallbackAtRetry 1.5 must be a whole number of at least 1.',
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
    warnings: [],
  });
});

it('accepts fallbackAtRetry 1', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-fallback-models-');

  writeUser({
    fallbackModels: { 'deepseek-flash': { ...validModel, fallbackAtRetry: 1 } },
  });

  expect(readUser(location)).toEqual({
    models: [
      {
        name: 'deepseek-flash',
        primary: 'a/primary',
        fallback: 'b/fallback',
        fallbackAtRetry: 1,
      },
    ],
    problems: [],
    warnings: [],
  });
});

it('reports the key in a trusted repository file', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-fallback-models-',
  );

  writeUser({ fallbackModels: { 'deepseek-flash': validModel } });
  writeRepository({ fallbackModels: { 'deepseek-flash': validModel } });

  expect(readFallbackModels(location)).toEqual({
    models: [],
    problems: [
      `Invalid Tau config ${repositoryFile}: fallbackModels may be set only in the user file ${userFile}. Remove fallbackModels from ${repositoryFile}.`,
    ],
    warnings: [],
  });
});

it('warns about an unknown entry key', ({ onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-fallback-models-',
  );

  writeUser({
    fallbackModels: {
      bad: { ...validModel, extra: true },
      'deepseek-flash': validModel,
    },
  });

  expect(readUser(location)).toEqual({
    models: [
      {
        name: 'bad',
        primary: 'a/primary',
        fallback: 'b/fallback',
        fallbackAtRetry: 5,
      },
      {
        name: 'deepseek-flash',
        primary: 'a/primary',
        fallback: 'b/fallback',
        fallbackAtRetry: 5,
      },
    ],
    problems: [],
    warnings: [`Invalid Tau config ${userFile}: fallbackModels.bad has unknown key extra.`],
  });
});

it('warns about an unknown key on a refused entry and keeps the valid sibling', ({
  onTestFinished,
}) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-fallback-models-',
  );

  writeUser({
    fallbackModels: {
      bad: { ...validModel, fallbackAtRetry: 0, extra: true },
      'deepseek-flash': validModel,
    },
  });

  expect(readUser(location)).toEqual({
    models: [
      {
        name: 'deepseek-flash',
        primary: 'a/primary',
        fallback: 'b/fallback',
        fallbackAtRetry: 5,
      },
    ],
    problems: [
      `Invalid Tau config ${userFile}: fallbackModels.bad.fallbackAtRetry 0 must be a whole number of at least 1.`,
    ],
    warnings: [`Invalid Tau config ${userFile}: fallbackModels.bad has unknown key extra.`],
  });
});
