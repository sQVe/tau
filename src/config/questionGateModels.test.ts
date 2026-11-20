import { existsSync, readFileSync } from 'node:fs';

import { expect, it, onTestFinished as registerTestCleanup } from 'vitest';

import { temporaryTauConfig } from '../../tests/tauConfigHarness.ts';
import type { PastAnswer } from '../questionGate/questionGate.ts';
import { readQuestionGateConfig, shadowCohort } from './questionGateModels.ts';
import type { QuestionGateConfig, ShadowConfig } from './questionGateModels.ts';

interface ConfigBytes {
  user: string;
  repository: string | undefined;
}

type FrozenConfig = QuestionGateConfig & { shadow: ShadowConfig };

const models = {
  classifier: 'tau-fixture/judge-a',
  panel: ['tau-fixture/judge-a', 'tau-fixture/judge-b', 'tau-fixture/judge-c'] as [
    string,
    string,
    string,
  ],
};

const question = (text = 'Which route?') => ({
  question: text,
  problem: 'The route is open.',
  impact: 'The wrong route wastes a day.',
  options: [
    { label: 'Fast', description: 'Ship now.', recommended: true },
    { label: 'Careful', description: 'Check first.', recommended: false },
  ],
});

const pastAnswer = (time: number, text: string, questionText?: string): PastAnswer => ({
  time,
  question: question(questionText),
  outcome: { kind: 'typed', text },
});

const otherAnswer = (time: number, label: string): PastAnswer => ({
  time,
  question: question(),
  outcome: { kind: 'otherOption', label },
});

const frozenConfig = (): FrozenConfig => ({
  ...models,
  shadow: {
    variant: 'classifierExamples',
    cutoff: 0.8,
    examples: [pastAnswer(1, 'first'), pastAnswer(2, 'second')],
  },
});

const withShadow = (config: FrozenConfig, shadow: Partial<ShadowConfig>): FrozenConfig => ({
  ...config,
  shadow: { ...config.shadow, ...shadow },
});

const readBytes = (userFile: string, repositoryFile: string): ConfigBytes => ({
  user: readFileSync(userFile, 'utf8'),
  repository: existsSync(repositoryFile) ? readFileSync(repositoryFile, 'utf8') : undefined,
});

const expectBytesUnchanged = (
  before: ConfigBytes,
  userFile: string,
  repositoryFile: string,
): void => {
  const userAfter = readFileSync(userFile, 'utf8');

  const repositoryAfter = existsSync(repositoryFile)
    ? readFileSync(repositoryFile, 'utf8')
    : undefined;

  expect(userAfter).toBe(before.user);
  expect(repositoryAfter).toBe(before.repository);
};

it('reads a model-only user key and leaves the file unchanged', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({ questionGate: models });

  const before = readBytes(userFile, repositoryFile);

  expect(readQuestionGateConfig(location)).toEqual(models);
  expectBytesUnchanged(before, userFile, repositoryFile);
});

it('returns undefined when the key is missing', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-question-gate-');

  writeUser({});

  expect(readQuestionGateConfig(location)).toBeUndefined();
});

it('refuses a panel of two models with the schema error', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({
    questionGate: {
      classifier: 'tau-fixture/judge-a',
      panel: ['tau-fixture/judge-a', 'tau-fixture/judge-b'],
    },
  });

  const before = readBytes(userFile, repositoryFile);
  const read = () => readQuestionGateConfig(location);

  expect(read).toThrow(userFile);

  expect(read).toThrow(
    'questionGate needs classifier, a provider/model-id string, and panel, an array of three provider/model-id strings.',
  );

  expectBytesUnchanged(before, userFile, repositoryFile);
});

it('refuses an extra key with the schema error', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({ questionGate: { ...models, extra: true } });

  const before = readBytes(userFile, repositoryFile);
  const read = () => readQuestionGateConfig(location);

  expect(read).toThrow(
    'questionGate needs classifier, a provider/model-id string, and panel, an array of three provider/model-id strings.',
  );

  expectBytesUnchanged(before, userFile, repositoryFile);
});

it('refuses a panel string that is not a model reference', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({ questionGate: { classifier: 'a/b', panel: ['a/b', 'c/d', 'nope'] } });

  const before = readBytes(userFile, repositoryFile);
  const read = () => readQuestionGateConfig(location);

  expect(read).toThrow(userFile);
  expect(read).toThrow('questionGate model "nope" is not a provider/model-id reference.');
  expectBytesUnchanged(before, userFile, repositoryFile);
});

it('refuses the key in a trusted repository file', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({});
  writeRepository({ questionGate: models });

  const before = readBytes(userFile, repositoryFile);
  const read = () => readQuestionGateConfig(location);

  expect(read).toThrow(repositoryFile);
  expect(read).toThrow('questionGate may be set only in the user file');
  expectBytesUnchanged(before, userFile, repositoryFile);
});

it('reads a frozen shadow config and leaves the file unchanged', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  const shadow = {
    variant: 'classifierExamples',
    cutoff: 0.8,
    examples: [pastAnswer(1, 'first')],
  } as const;

  writeUser({ questionGate: { ...models, shadow } });

  const before = readBytes(userFile, repositoryFile);

  expect(readQuestionGateConfig(location)).toEqual({ ...models, shadow });
  expectBytesUnchanged(before, userFile, repositoryFile);
});

it('defaults omitted examples to an empty list', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-question-gate-');

  writeUser({ questionGate: { ...models, shadow: { variant: 'panel', cutoff: 0.5 } } });

  expect(readQuestionGateConfig(location)).toEqual({
    ...models,
    shadow: { variant: 'panel', cutoff: 0.5, examples: [] },
  });
});

it.each<[string, unknown]>([
  ['an unknown variant', { variant: 'nope', cutoff: 0.5 }],
  ['a cutoff above 1', { variant: 'panel', cutoff: 1.5 }],
  ['a negative cutoff', { variant: 'panel', cutoff: -0.1 }],
  [
    'more than five examples',
    {
      variant: 'panel',
      cutoff: 0.5,
      examples: [1, 2, 3, 4, 5, 6].map((time) => pastAnswer(time, 'answer')),
    },
  ],
  ['a malformed example', { variant: 'panel', cutoff: 0.5, examples: [{ time: 1 }] }],
  ['an extra key', { variant: 'panel', cutoff: 0.5, extra: true }],
])('refuses a shadow config with %s', (_label, shadow) => {
  const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
    registerTestCleanup,
    'tau-question-gate-',
  );

  writeUser({ questionGate: { ...models, shadow } });

  const before = readBytes(userFile, repositoryFile);
  const read = () => readQuestionGateConfig(location);

  expect(read).toThrow(userFile);

  expect(read).toThrow(
    'questionGate shadow needs a variant, a cutoff from 0 to 1, and up to five past-answer examples.',
  );

  expectBytesUnchanged(before, userFile, repositoryFile);
});

it.each(['classifierExamples', 'panelExamples'] as const)(
  'refuses %s with no examples',
  (variant) => {
    const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
      registerTestCleanup,
      'tau-question-gate-',
    );

    writeUser({
      questionGate: {
        ...models,
        shadow: { variant, cutoff: 0.5, examples: [] },
      },
    });

    const before = readBytes(userFile, repositoryFile);
    const read = () => readQuestionGateConfig(location);

    expect(read).toThrow(userFile);

    expect(read).toThrow(
      `questionGate shadow variant ${JSON.stringify(variant)} needs at least one example.`,
    );

    expectBytesUnchanged(before, userFile, repositoryFile);
  },
);

it('changes the cohort when an other-option label changes', () => {
  const careful = withShadow(frozenConfig(), { examples: [otherAnswer(1, 'Careful')] });
  const fast = withShadow(frozenConfig(), { examples: [otherAnswer(1, 'Fast')] });

  expect(shadowCohort(careful)).not.toBe(shadowCohort(fast));
});

it('keeps the cohort when JSON keys are reordered', () => {
  const reordered: FrozenConfig = {
    shadow: {
      examples: [
        {
          outcome: { kind: 'typed', text: 'first' },
          question: {
            options: [
              { recommended: true, description: 'Ship now.', label: 'Fast' },
              { recommended: false, description: 'Check first.', label: 'Careful' },
            ],
            impact: 'The wrong route wastes a day.',
            problem: 'The route is open.',
            question: 'Which route?',
          },
          time: 1,
        },
        {
          outcome: { kind: 'typed', text: 'second' },
          question: {
            options: [
              { recommended: true, description: 'Ship now.', label: 'Fast' },
              { recommended: false, description: 'Check first.', label: 'Careful' },
            ],
            impact: 'The wrong route wastes a day.',
            problem: 'The route is open.',
            question: 'Which route?',
          },
          time: 2,
        },
      ],
      cutoff: 0.8,
      variant: 'classifierExamples',
    },
    panel: ['tau-fixture/judge-a', 'tau-fixture/judge-b', 'tau-fixture/judge-c'],
    classifier: 'tau-fixture/judge-a',
  };

  expect(shadowCohort(reordered)).toBe(shadowCohort(frozenConfig()));
});

it.each<[string, (config: FrozenConfig) => FrozenConfig]>([
  ['classifier', (config) => ({ ...config, classifier: 'tau-fixture/judge-z' })],
  [
    'panel',
    (config) => ({
      ...config,
      panel: ['tau-fixture/judge-a', 'tau-fixture/judge-b', 'tau-fixture/judge-z'],
    }),
  ],
  ['variant', (config) => withShadow(config, { variant: 'panelExamples' })],
  ['cutoff', (config) => withShadow(config, { cutoff: 0.81 })],
  [
    'example time',
    (config) => withShadow(config, { examples: [pastAnswer(9, 'first'), pastAnswer(2, 'second')] }),
  ],
  [
    'example question',
    (config) =>
      withShadow(config, {
        examples: [pastAnswer(1, 'first', 'Which database?'), pastAnswer(2, 'second')],
      }),
  ],
  [
    'example outcome',
    (config) =>
      withShadow(config, { examples: [pastAnswer(1, 'changed'), pastAnswer(2, 'second')] }),
  ],
  [
    'example order',
    (config) => withShadow(config, { examples: [pastAnswer(2, 'second'), pastAnswer(1, 'first')] }),
  ],
  ['example count', (config) => withShadow(config, { examples: [pastAnswer(1, 'first')] })],
])('changes the cohort when %s changes', (_label, change) => {
  expect(shadowCohort(change(frozenConfig()))).not.toBe(shadowCohort(frozenConfig()));
});
