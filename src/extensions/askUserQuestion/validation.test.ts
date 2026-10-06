import { expect, it } from 'vitest';

import { validateQuestions } from './validation.js';
import type { QuestionInput } from './validation.js';

const layout: QuestionInput = {
  question: 'Which layout should the dashboard use?',
  context: 'The dashboard ships next week. Changing the layout later moves every panel.',
  options: [{ label: 'Stacked' }, { label: 'Split' }],
};

const withOptions = (change: Partial<QuestionInput['options'][number]>[]): QuestionInput => ({
  ...layout,
  options: layout.options.map((option, index) => ({ ...option, ...change[index] })),
});

it.each([
  { rule: 'no recommendation or previews', questions: [layout] },
  {
    rule: 'a recommended first option and a preview on every option',
    questions: [withOptions([{ recommended: true, preview: 'one' }, { preview: 'two' }])],
  },
  { rule: 'a preview on only some options', questions: [withOptions([{ preview: 'one' }])] },
])('accepts $rule', ({ questions }) => {
  expect(() => {
    validateQuestions(questions);
  }).not.toThrow();
});

it.each([
  { rule: 'a blank context', questions: [{ ...layout, context: ' \n ' }], error: /context/u },
  {
    rule: 'a context that repeats the question',
    questions: [{ ...layout, context: ` ${layout.question} ` }],
    error: /context/u,
  },
  { rule: 'a repeated question', questions: [layout, layout], error: /unique/u },
  {
    rule: 'a reserved label',
    questions: [withOptions([{ label: 'Type something.' }])],
    error: /reserved/u,
  },
  {
    rule: 'a repeated label',
    questions: [withOptions([{}, { label: 'Stacked' }])],
    error: /unique/u,
  },
  {
    rule: 'more than one recommended option',
    questions: [withOptions([{ recommended: true }, { recommended: true }])],
    error: /at most one/u,
  },
  {
    rule: 'a recommended option that is not first',
    questions: [withOptions([{}, { recommended: true }])],
    error: /first/u,
  },
  {
    rule: 'a "(Recommended)" label',
    questions: [withOptions([{ label: 'Stacked (Recommended)' }])],
    error: /Recommended/u,
  },
  {
    rule: 'a blank preview',
    questions: [withOptions([{ preview: ' ' }, { preview: 'two' }])],
    error: /blank/u,
  },
])('rejects $rule', ({ questions, error }) => {
  expect(() => {
    validateQuestions(questions);
  }).toThrow(error);
});
