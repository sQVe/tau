import { expect, it, onTestFinished as registerTestCleanup } from 'vitest';

import { tauConfigSnapshot, temporaryTauConfig } from '../../tests/tauConfigHarness.ts';
import type { PastAnswer } from '../questionGate/questionGate.ts';
import { models, pastAnswer, question } from './fixtures/questionGateModelsFixture.ts';
import {
  readQuestionGateConfig,
  readQuestionGateModels,
  readQuestionGateShadow,
  shadowCohort,
} from './questionGateModels.ts';
import type { QuestionGateConfig, ShadowConfig } from './questionGateModels.ts';

type FrozenConfig = QuestionGateConfig & { shadow: ShadowConfig };

const ui = () => ({ notify: () => undefined });

const otherAnswer = (time: number, label: string): PastAnswer => ({
  time,
  question: question(),
  outcome: { kind: 'otherOption', label },
});

const withFirstOption = (
  answer: PastAnswer,
  change: Partial<PastAnswer['question']['options'][number]>,
): PastAnswer => ({
  ...answer,
  question: {
    ...answer.question,
    options: answer.question.options.map((option, index) =>
      index === 0 ? { ...option, ...change } : option,
    ),
  },
});

const frozenConfig = (): FrozenConfig => ({
  ...models,
  decide: false,
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

it('reads a model-only user key and leaves the file unchanged', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({ questionGate: models });

  const snapshot = tauConfigSnapshot(userFile, repositoryFile);

  expect(readQuestionGateConfig(location, ui())).toEqual({ ...models, decide: false });
  snapshot.expectUnchanged();
});

it('returns undefined when the key is missing', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-question-gate-');

  writeUser({});

  expect(readQuestionGateConfig(location, ui())).toBeUndefined();
});

it('reads models without validating the shadow block', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-question-gate-');

  writeUser({
    questionGate: {
      ...models,
      shadow: { variant: 'classifierExamples', cutoff: 0.8, examples: [] },
    },
  });

  expect(readQuestionGateModels(location, ui())).toEqual(models);
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

  const snapshot = tauConfigSnapshot(userFile, repositoryFile);
  const read = () => readQuestionGateConfig(location, ui());

  expect(read).toThrow(userFile);

  expect(read).toThrow(
    'questionGate needs classifier, a provider/model-id string, and panel, an array of three provider/model-id strings.',
  );

  snapshot.expectUnchanged();
});

it('refuses a panel string that is not a model reference', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({ questionGate: { classifier: 'a/b', panel: ['a/b', 'c/d', 'nope'] } });

  const snapshot = tauConfigSnapshot(userFile, repositoryFile);
  const read = () => readQuestionGateConfig(location, ui());

  expect(read).toThrow(userFile);
  expect(read).toThrow('questionGate model "nope" is not a provider/model-id reference.');
  snapshot.expectUnchanged();
});

it('refuses the key in a trusted repository file', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({});
  writeRepository({ questionGate: models });

  const snapshot = tauConfigSnapshot(userFile, repositoryFile);
  const read = () => readQuestionGateConfig(location, ui());

  expect(read).toThrow(repositoryFile);
  expect(read).toThrow('questionGate may be set only in the user file');
  snapshot.expectUnchanged();
});

it('refuses decide without shadow', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({ questionGate: { ...models, decide: true } });

  const snapshot = tauConfigSnapshot(userFile, repositoryFile);
  const read = () => readQuestionGateConfig(location, ui());

  expect(read).toThrow(userFile);

  expect(read).toThrow('questionGate decide needs shadow, the frozen judge and cutoff it uses.');

  snapshot.expectUnchanged();
});

it('reads decide with shadow', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-question-gate-');

  const shadow = { variant: 'panel', cutoff: 0.5 } as const;

  writeUser({ questionGate: { ...models, decide: true, shadow } });

  expect(readQuestionGateConfig(location, ui())).toEqual({
    ...models,
    decide: true,
    shadow: { ...shadow, examples: [] },
  });
});

it('refuses an invalid shadow in a decide config', ({ onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({
    questionGate: {
      ...models,
      decide: true,
      shadow: { variant: 'classifierExamples', cutoff: 0.8, examples: [] },
    },
  });

  const read = () => readQuestionGateConfig(location, ui());

  expect(read).toThrow(userFile);
  expect(read).toThrow('classifierExamples');
  expect(read).toThrow('needs at least one example');
});

it('reads the shadow without validating decide', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-question-gate-');
  const shadow = { variant: 'panel', cutoff: 0.5 } as const;

  writeUser({ questionGate: { ...models, decide: 'yes', shadow } });

  expect(readQuestionGateShadow(location, ui())).toEqual({
    ...models,
    shadow: { ...shadow, examples: [] },
  });
});

it('defaults decide to off', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-question-gate-');

  writeUser({ questionGate: models });

  expect(readQuestionGateConfig(location, ui())).toEqual({ ...models, decide: false });
});

it('refuses a decide that is not a boolean', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({ questionGate: { ...models, decide: 'yes' } });

  const snapshot = tauConfigSnapshot(userFile, repositoryFile);
  const read = () => readQuestionGateConfig(location, ui());

  expect(read).toThrow(userFile);
  expect(read).toThrow('questionGate decide must be true or false.');
  snapshot.expectUnchanged();
});

const decidedShadowOf = (config: QuestionGateConfig): ShadowConfig | null =>
  config.decide ? config.shadow : null;

it('gives a decide config a shadow without a non-null assertion', () => {
  const shadow: ShadowConfig = {
    variant: 'classifierExamples',
    cutoff: 0.8,
    examples: [pastAnswer(1, 'first')],
  };

  const config: QuestionGateConfig = { ...models, decide: true, shadow };

  expect(decidedShadowOf(config)).toBe(shadow);
});

it('still reads a decide config that is off', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-question-gate-');
  const shadow = { variant: 'panel', cutoff: 0.5 } as const;

  writeUser({ questionGate: { ...models, decide: false, shadow } });

  expect(readQuestionGateConfig(location, ui())).toEqual({
    ...models,
    decide: false,
    shadow: { ...shadow, examples: [] },
  });
});

it('keeps the cohort when decide changes', () => {
  const off: FrozenConfig = { ...frozenConfig(), decide: false };
  const on: FrozenConfig = { ...frozenConfig(), decide: true };

  expect(shadowCohort(on)).toBe(shadowCohort(off));
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

  const snapshot = tauConfigSnapshot(userFile, repositoryFile);

  expect(readQuestionGateConfig(location, ui())).toEqual({ ...models, decide: false, shadow });
  snapshot.expectUnchanged();
});

it('defaults omitted examples to an empty list', ({ onTestFinished }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-question-gate-');

  writeUser({ questionGate: { ...models, shadow: { variant: 'panel', cutoff: 0.5 } } });

  expect(readQuestionGateConfig(location, ui())).toEqual({
    ...models,
    decide: false,
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
])('refuses a shadow config with %s', (_label, shadow) => {
  const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
    registerTestCleanup,
    'tau-question-gate-',
  );

  writeUser({ questionGate: { ...models, shadow } });

  const snapshot = tauConfigSnapshot(userFile, repositoryFile);
  const read = () => readQuestionGateConfig(location, ui());

  expect(read).toThrow(userFile);

  expect(read).toThrow(
    'questionGate shadow needs a variant, a cutoff from 0 to 1, and up to five past-answer examples.',
  );

  snapshot.expectUnchanged();
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

    const snapshot = tauConfigSnapshot(userFile, repositoryFile);
    const read = () => readQuestionGateConfig(location, ui());

    expect(read).toThrow(userFile);

    expect(read).toThrow(
      `questionGate shadow variant ${JSON.stringify(variant)} needs at least one example.`,
    );

    snapshot.expectUnchanged();
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
    decide: false,
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
    'example question option label',
    (config) =>
      withShadow(config, {
        examples: [
          withFirstOption(pastAnswer(1, 'first'), { label: 'Quick' }),
          pastAnswer(2, 'second'),
        ],
      }),
  ],
  [
    'example question option description',
    (config) =>
      withShadow(config, {
        examples: [
          withFirstOption(pastAnswer(1, 'first'), { description: 'Ship faster.' }),
          pastAnswer(2, 'second'),
        ],
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
