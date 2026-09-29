import { expect, it } from 'vitest';

import { handleKey, initialState, isCustomChecked, withCustomText } from './questionnaire.js';
import type { KeyPress, QuestionFacts, QuestionnaireState } from './questionnaire.js';

const multi: QuestionFacts = {
  question: 'Which features?',
  multiSelect: true,
  options: [{ label: 'Lint' }, { label: 'Format' }, { label: 'Test' }],
};

const single: QuestionFacts = {
  question: 'Which library?',
  multiSelect: false,
  options: [{ label: 'Luxon', preview: 'luxon()' }, { label: 'Temporal' }],
};

const press = (kind: KeyPress['kind'], typed = false) => ({ kind, typed }) as KeyPress;

const at = (
  questions: QuestionFacts[],
  cursor: number,
  change: { checked?: number[]; customText?: string; tab?: number } = {},
): QuestionnaireState => {
  const state = initialState(questions.length);
  const tab = change.tab ?? 0;

  return {
    ...state,
    tab,
    questions: state.questions.with(tab, {
      cursor,
      checked: change.checked ?? [],
      customText: change.customText ?? '',
    }),
  };
};

const run = (questions: QuestionFacts[], state: QuestionnaireState, keys: KeyPress[]) => {
  let current = state;

  for (const key of keys) {
    const outcome = handleKey(current, key, questions);

    if (outcome.kind !== 'update') {
      return outcome;
    }

    current = outcome.state;
  }

  return { kind: 'update' as const, state: current };
};

it.each([
  {
    rule: 'Space checks the focused option',
    question: multi,
    state: at([multi], 1),
    keys: [press('space')],
    checked: [1],
  },
  {
    rule: 'Space unchecks a checked option',
    question: multi,
    state: at([multi], 1, { checked: [0, 1] }),
    keys: [press('space')],
    checked: [0],
  },
  {
    rule: 'Space does nothing in single-select',
    question: single,
    state: at([single], 0),
    keys: [press('space')],
    checked: [],
  },
  {
    rule: 'vim keys move between options',
    question: multi,
    state: at([multi], 0),
    keys: [press('down', true), press('down', true), press('space')],
    checked: [2],
  },
])('$rule', ({ question, state, keys, checked }) => {
  const outcome = run([question], state, keys);

  expect(outcome).toMatchObject({ kind: 'update' });
  expect(outcome.kind === 'update' && outcome.state.questions[0]?.checked).toEqual(checked);
});

it.each([
  {
    rule: 'Space types a space on the custom row',
    questions: [multi],
    state: at([multi], 3),
    key: press('space'),
  },
  {
    rule: 'vim keys type on the custom row',
    questions: [multi],
    state: at([multi], 3),
    key: press('up', true),
  },
  {
    rule: 'Home and End move the typing cursor on the custom row',
    questions: [single],
    state: at([single], 2),
    key: press('top'),
  },
  {
    rule: 'other keys type on the custom row',
    questions: [single],
    state: at([single], 2),
    key: press('other'),
  },
])('$rule', ({ questions, state, key }) => {
  expect(handleKey(state, key, questions)).toEqual({ kind: 'type' });
});

it.each([
  {
    rule: 'Enter submits checked options from an option row',
    questions: [multi],
    state: at([multi], 1, { checked: [2, 0] }),
    selected: ['Lint', 'Test'],
  },
  {
    rule: 'Enter submits from the custom row while typing',
    questions: [multi],
    state: at([multi], 3, { checked: [1], customText: 'Docs' }),
    selected: ['Format', 'Docs'],
  },
  {
    rule: 'Enter submits typed text together with checked options',
    questions: [multi],
    state: at([multi], 0, { checked: [0], customText: ' Docs ' }),
    selected: ['Lint', 'Docs'],
  },
  {
    rule: 'Enter leaves out an empty custom row',
    questions: [multi],
    state: at([multi], 0, { checked: [0], customText: '  ' }),
    selected: ['Lint'],
  },
  {
    rule: 'Enter picks the focused single-select option',
    questions: [single],
    state: at([single], 1, { customText: 'ignored' }),
    selected: ['Temporal'],
  },
  {
    rule: 'Enter picks the typed single-select answer',
    questions: [single],
    state: at([single], 2, { customText: 'date-fns' }),
    selected: ['date-fns'],
  },
])('$rule', ({ questions, state, selected }) => {
  expect(handleKey(state, press('enter'), questions)).toEqual({
    kind: 'submit',
    answers: [{ question: questions[0]?.question, selected }],
  });
});

it('returns the preview of a picked single-select option', () => {
  expect(handleKey(at([single], 0), press('enter'), [single])).toEqual({
    kind: 'submit',
    answers: [{ question: 'Which library?', selected: ['Luxon'], preview: 'luxon()' }],
  });
});

it.each([
  { rule: 'nothing checked in multi-select', questions: [multi], state: at([multi], 0) },
  { rule: 'an empty custom row in single-select', questions: [single], state: at([single], 2) },
])('ignores Enter with $rule', ({ questions, state }) => {
  expect(handleKey(state, press('enter'), questions)).toEqual({ kind: 'update', state });
});

it('checks the custom row exactly when it has text', () => {
  expect([isCustomChecked(''), isCustomChecked(' \t'), isCustomChecked('Docs')]).toEqual([
    false,
    false,
    true,
  ]);
});

it('keeps typed text per question', () => {
  const state = withCustomText({ ...initialState(2), tab: 1 }, 'Docs');

  expect(state.questions.map((question) => question.customText)).toEqual(['', 'Docs']);
});

it('answers questions in turn and submits after the last one', () => {
  const questions = [single, multi];
  const first = run(questions, initialState(2), [press('enter')]);

  expect(first).toMatchObject({ kind: 'update', state: { tab: 1 } });

  const second = run(questions, (first as { state: QuestionnaireState }).state, [
    press('space'),
    press('enter'),
  ]);

  expect(second).toEqual({
    kind: 'submit',
    answers: [
      { question: 'Which library?', selected: ['Luxon'], preview: 'luxon()' },
      { question: 'Which features?', selected: ['Lint'] },
    ],
  });
});

it('returns to an unanswered question before submitting', () => {
  const questions = [single, multi];
  const skipped = run(questions, initialState(2), [press('nextQuestion'), press('space')]);
  const state = (skipped as { state: QuestionnaireState }).state;

  expect(run(questions, state, [press('enter')])).toMatchObject({
    kind: 'update',
    state: { tab: 0 },
  });
});

it.each([
  { key: press('nextQuestion'), from: 0, tab: 1 },
  { key: press('nextQuestion'), from: 1, tab: 0 },
  { key: press('previousQuestion'), from: 0, tab: 1 },
])('switches questions with $key.kind from $from', ({ key, from, tab }) => {
  const state = { ...initialState(2), tab: from };

  expect(handleKey(state, key, [single, multi])).toMatchObject({ kind: 'update', state: { tab } });
});

it.each([
  { row: 'an option', state: at([multi], 0) },
  { row: 'the custom row', state: at([multi], 3, { customText: 'Docs' }) },
])('cancels with Esc on $row', ({ state }) => {
  expect(handleKey(state, press('cancel'), [multi])).toEqual({ kind: 'cancel' });
});

it('submits a changed answer after returning to an answered question', () => {
  const questions = [multi, single];

  const outcome = run(questions, initialState(2), [
    press('space'),
    press('enter'),
    press('previousQuestion'),
    press('down'),
    press('space'),
    press('nextQuestion'),
    press('enter'),
    press('enter'),
  ]);

  expect(outcome).toEqual({
    kind: 'submit',
    answers: [
      { question: 'Which features?', selected: ['Lint', 'Format'] },
      { question: 'Which library?', selected: ['Luxon'], preview: 'luxon()' },
    ],
  });
});

it('keeps an answer when the user only moves through a multi-select question', () => {
  const questions = [multi, single];

  const outcome = run(questions, initialState(2), [
    press('space'),
    press('enter'),
    press('previousQuestion'),
    press('down'),
    press('nextQuestion'),
    press('enter'),
  ]);

  expect(outcome).toEqual({
    kind: 'submit',
    answers: [
      { question: 'Which features?', selected: ['Lint'] },
      { question: 'Which library?', selected: ['Luxon'], preview: 'luxon()' },
    ],
  });
});
