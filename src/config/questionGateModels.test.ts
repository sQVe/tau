import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { temporaryTauConfig } from '../../tests/tauConfigHarness.js';
import { readQuestionGateModels } from './questionGateModels.js';

const models = {
  classifier: 'tau-fixture/judge-a',
  panel: ['tau-fixture/judge-a', 'tau-fixture/judge-b', 'tau-fixture/judge-c'],
} as const;

it('reads a valid user key and leaves the file unchanged', ({ onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({ questionGate: models });

  const before = readFileSync(userFile, 'utf8');

  expect(readQuestionGateModels(location)).toEqual(models);
  expect(readFileSync(userFile, 'utf8')).toBe(before);
});

it('returns undefined when the key is missing', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-question-gate-');

  writeUser({});

  expect(readQuestionGateModels(location)).toBeUndefined();
});

it('refuses a panel of two models with the schema error', ({ onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({
    questionGate: {
      classifier: 'tau-fixture/judge-a',
      panel: ['tau-fixture/judge-a', 'tau-fixture/judge-b'],
    },
  });

  const read = () => readQuestionGateModels(location);

  expect(read).toThrow(userFile);

  expect(read).toThrow(
    'questionGate needs classifier, a provider/model-id string, and panel, an array of three provider/model-id strings.',
  );
});

it('refuses an extra key with the schema error', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-question-gate-');

  writeUser({ questionGate: { ...models, extra: true } });

  expect(() => readQuestionGateModels(location)).toThrow(
    'questionGate needs classifier, a provider/model-id string, and panel, an array of three provider/model-id strings.',
  );
});

it('refuses a panel string that is not a model reference', ({ onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({ questionGate: { classifier: 'a/b', panel: ['a/b', 'c/d', 'nope'] } });

  const read = () => readQuestionGateModels(location);

  expect(read).toThrow(userFile);
  expect(read).toThrow('questionGate model "nope" is not a provider/model-id reference.');
});

it('refuses the key in a trusted repository file', ({ onTestFinished }) => {
  const { location, repositoryFile, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({});
  writeRepository({ questionGate: models });

  expect(() => readQuestionGateModels(location)).toThrow(repositoryFile);

  expect(() => readQuestionGateModels(location)).toThrow(
    'questionGate may be set only in the user file',
  );
});
