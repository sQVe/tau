import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import type { QuestionGateConfig, ShadowConfig } from '../../config/questionGateModels.js';
import type { JudgeQuestion, ShadowVariant } from '../../questionGate/questionGate.js';
import { prepareJudges, variantModels } from './judges.js';

const config: QuestionGateConfig & { shadow: ShadowConfig } = {
  classifier: 'tau-fixture/classifier',
  panel: ['tau-fixture/panel-a', 'tau-fixture/panel-b', 'tau-fixture/panel-c'],
  decide: true,
  shadow: { variant: 'classifier', cutoff: 0.8, examples: [] },
};

const question: JudgeQuestion = {
  question: 'Which layout should the dashboard use?',
  problem: 'The dashboard ships next week.',
  impact: 'Changing the layout later moves every panel.',
  options: [
    { label: 'Stacked', description: 'One column.', recommended: true },
    { label: 'Split', description: 'Two columns.', recommended: false },
  ],
};

const registry = (): ModelRegistry =>
  ({
    find: (provider: string, id: string) => ({ provider, id }),
    complete: () => Promise.reject(new Error('Unexpected model call.')),
  }) as unknown as ModelRegistry;

it.each<[ShadowVariant, string[]]>([
  ['classifier', ['tau-fixture/classifier']],
  ['classifierExamples', ['tau-fixture/classifier']],
  ['panel', [...config.panel]],
  ['panelExamples', [...config.panel]],
  ['agent', []],
])('names the models for the %s variant', (variant, expected) => {
  expect(variantModels(variant, config)).toEqual(expected);
});

it('returns the agent confidence', async () => {
  const judges = prepareJudges(registry(), config);

  await expect(judges.judge('agent', question, 0.7, new AbortController().signal)).resolves.toEqual(
    { kind: 'answered', confidence: 0.7 },
  );
});

it('returns unavailable without an agent confidence', async () => {
  const judges = prepareJudges(registry(), config);

  await expect(
    judges.judge('agent', question, undefined, new AbortController().signal),
  ).resolves.toEqual({ kind: 'unavailable' });
});
