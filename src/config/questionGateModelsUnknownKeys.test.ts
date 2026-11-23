import { Value } from 'typebox/value';
import { expect, it, vi } from 'vitest';

import { tauConfigSnapshot, temporaryTauConfig } from '../../tests/tauConfigHarness.ts';
import { pastAnswerSchema } from '../judgeSchema.ts';
import { models, pastAnswer, question } from './fixtures/questionGateModelsFixture.ts';
import {
  readQuestionGateConfig,
  readQuestionGateModels,
  shadowCohort,
} from './questionGateModels.ts';
import type { ShadowConfig } from './questionGateModels.ts';

const shadow: ShadowConfig = {
  variant: 'classifierExamples',
  cutoff: 0.8,
  examples: [pastAnswer(1, 'first')],
};

const uiFixture = () => ({ notify: vi.fn<(message: string, level?: string) => void>() });

type UiFixture = ReturnType<typeof uiFixture>;

const expectWarning = (ui: UiFixture, userFile: string, keyPath: string): void => {
  const calls = ui.notify.mock.calls.filter(([message]) => message.includes(keyPath));

  expect(calls).toHaveLength(1);

  const [message, level] = calls[0] ?? [];

  expect(message).toContain(userFile);
  expect(level).toBe('warning');
};

const shadowCohortOf = (value: ShadowConfig): string => shadowCohort({ ...models, shadow: value });

it('reads an extra key beside classifier and warns once with its path', ({ onTestFinished }) => {
  const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({ questionGate: { ...models, extra: true } });

  const snapshot = tauConfigSnapshot(userFile, repositoryFile);
  const ui = uiFixture();

  expect(readQuestionGateModels(location, ui)).toEqual(models);
  snapshot.expectUnchanged();

  expectWarning(ui, userFile, 'questionGate.extra');

  expect(ui.notify).toHaveBeenCalledTimes(1);

  readQuestionGateModels(location, ui);
  snapshot.expectUnchanged();

  expect(ui.notify).toHaveBeenCalledTimes(1);
});

it('accepts a field from another outcome variant, drops it, and warns nothing', ({
  onTestFinished,
}) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-question-gate-');

  writeUser({
    questionGate: {
      ...models,
      shadow: {
        variant: 'classifierExamples',
        cutoff: 0.8,
        examples: [
          { time: 1, question: question(), outcome: { kind: 'recommended', label: 'ignored' } },
        ],
      },
    },
  });

  const ui = uiFixture();

  expect(readQuestionGateConfig(location, ui)).toEqual({
    ...models,
    decide: false,
    shadow: {
      variant: 'classifierExamples',
      cutoff: 0.8,
      examples: [{ time: 1, question: question(), outcome: { kind: 'recommended' } }],
    },
  });

  expect(ui.notify).not.toHaveBeenCalled();
});

it('warns about an unknown key inside an outcome variant and drops it', ({ onTestFinished }) => {
  const { location, userFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({
    questionGate: {
      ...models,
      shadow: {
        variant: 'classifierExamples',
        cutoff: 0.8,
        examples: [
          { time: 1, question: question(), outcome: { kind: 'typed', text: 'first', extra: true } },
        ],
      },
    },
  });

  const ui = uiFixture();
  const config = readQuestionGateConfig(location, ui);

  expect(config?.shadow?.examples[0]?.outcome).toEqual({ kind: 'typed', text: 'first' });

  expectWarning(ui, userFile, 'questionGate.shadow.examples[0].outcome.extra');

  expect(ui.notify).toHaveBeenCalledTimes(1);
});

it('reads extra keys inside shadow and examples, warns once per path, and keeps the cohort', ({
  onTestFinished,
}) => {
  const { location, userFile, repositoryFile, writeUser } = temporaryTauConfig(
    onTestFinished,
    'tau-question-gate-',
  );

  writeUser({ questionGate: { ...models, shadow } });

  const cohort = shadowCohortOf(shadow);
  const exampleQuestion = question();

  writeUser({
    questionGate: {
      ...models,
      shadow: {
        ...shadow,
        extra: true,
        examples: [
          {
            ...pastAnswer(1, 'first'),
            question: {
              ...exampleQuestion,
              options: [
                { ...exampleQuestion.options[0], note: 'ignored' },
                exampleQuestion.options[1],
              ],
            },
          },
        ],
      },
    },
  });

  const ui = uiFixture();
  const snapshot = tauConfigSnapshot(userFile, repositoryFile);
  const config = readQuestionGateConfig(location, ui);

  expect(config).toEqual({ ...models, decide: false, shadow });
  snapshot.expectUnchanged();

  const examples = config?.shadow?.examples ?? [];

  expect(examples.every((example) => Value.Check(pastAnswerSchema, example))).toBe(true);

  const readCohort =
    config?.shadow === undefined ? undefined : shadowCohort({ ...config, shadow: config.shadow });

  expect(readCohort).toBe(cohort);

  expectWarning(ui, userFile, 'questionGate.shadow.extra');
  expectWarning(ui, userFile, 'questionGate.shadow.examples[0].question.options[0].note');

  expect(ui.notify).toHaveBeenCalledTimes(2);
});
