import { expect, it } from 'vitest';

import {
  handleKey,
  initialState,
  isCustomChecked,
  restoredState,
  withCustomText,
} from './questionnaire.js';
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

// The full preview shows 3 rows of the 5-line layout preview below.
const viewport = { rows: 3, lineCount: 5 };

const press = (kind: KeyPress['kind'], typed = false) => ({ kind, typed }) as KeyPress;

const at = (
  questions: QuestionFacts[],
  cursor: number,
  change: { checked?: number[]; customText?: string; tab?: number } = {},
): QuestionnaireState => {
  const state = initialState(questions);
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
    const outcome = handleKey(current, key, questions, viewport, false);

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
  expect(handleKey(state, key, questions, viewport, false)).toEqual({ kind: 'type' });
});

it.each([
  {
    rule: 'Enter submits checked options from an option row',
    questions: [multi],
    state: at([multi], 1, { checked: [2, 0] }),
    selected: ['Lint', 'Test'],
    typed: false,
  },
  {
    rule: 'Enter submits from the custom row while typing',
    questions: [multi],
    state: at([multi], 3, { checked: [1], customText: 'Docs' }),
    selected: ['Format', 'Docs'],
    typed: true,
  },
  {
    rule: 'Enter submits typed text together with checked options',
    questions: [multi],
    state: at([multi], 0, { checked: [0], customText: ' Docs ' }),
    selected: ['Lint', 'Docs'],
    typed: true,
  },
  {
    rule: 'Enter leaves out an empty custom row',
    questions: [multi],
    state: at([multi], 0, { checked: [0], customText: '  ' }),
    selected: ['Lint'],
    typed: false,
  },
  {
    rule: 'Enter picks the focused single-select option',
    questions: [single],
    state: at([single], 1, { customText: 'ignored' }),
    selected: ['Temporal'],
    typed: false,
  },
  {
    rule: 'Enter picks the typed single-select answer',
    questions: [single],
    state: at([single], 2, { customText: 'date-fns' }),
    selected: ['date-fns'],
    typed: true,
  },
  {
    rule: 'Enter records typed text equal to an option label as typed',
    questions: [single],
    state: at([single], 2, { customText: 'Luxon' }),
    selected: ['Luxon'],
    typed: true,
  },
])('$rule', ({ questions, state, selected, typed }) => {
  expect(handleKey(state, press('enter'), questions, viewport, false)).toEqual({
    kind: 'submit',
    answers: [{ question: questions[0]?.question, selected, typed }],
  });
});

it('returns the preview of a picked single-select option', () => {
  expect(handleKey(at([single], 0), press('enter'), [single], viewport, false)).toEqual({
    kind: 'submit',
    answers: [
      { question: 'Which library?', selected: ['Luxon'], typed: false, preview: 'luxon()' },
    ],
  });
});

it.each([
  { rule: 'nothing checked in multi-select', questions: [multi], state: at([multi], 0) },
  { rule: 'an empty custom row in single-select', questions: [single], state: at([single], 2) },
])('ignores Enter with $rule', ({ questions, state }) => {
  expect(handleKey(state, press('enter'), questions, viewport, false)).toEqual({
    kind: 'update',
    state,
  });
});

it('checks the custom row exactly when it has text', () => {
  expect([isCustomChecked(''), isCustomChecked(' \t'), isCustomChecked('Docs')]).toEqual([
    false,
    false,
    true,
  ]);
});

it('keeps typed text per question', () => {
  const state = withCustomText({ ...initialState([single, multi]), tab: 1 }, 'Docs');

  expect(state.questions.map((question) => question.customText)).toEqual(['', 'Docs']);
});

it('answers questions in turn and submits after the last one', () => {
  const questions = [single, multi];
  const first = run(questions, initialState(questions), [press('enter')]);

  expect(first).toMatchObject({ kind: 'update', state: { tab: 1 } });

  const second = run(questions, (first as { state: QuestionnaireState }).state, [
    press('space'),
    press('enter'),
  ]);

  expect(second).toEqual({
    kind: 'submit',
    answers: [
      { question: 'Which library?', selected: ['Luxon'], typed: false, preview: 'luxon()' },
      { question: 'Which features?', selected: ['Lint'], typed: false },
    ],
  });
});

it('returns to an unanswered question before submitting', () => {
  const questions = [single, multi];
  const skipped = run(questions, initialState(questions), [press('nextQuestion'), press('space')]);
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
  const state = { ...initialState([single, multi]), tab: from };

  expect(handleKey(state, key, [single, multi], viewport, false)).toMatchObject({
    kind: 'update',
    state: { tab },
  });
});

it.each([
  { row: 'an option', state: at([multi], 0) },
  { row: 'the custom row', state: at([multi], 3, { customText: 'Docs' }) },
])('cancels with Esc on $row', ({ state }) => {
  expect(handleKey(state, press('cancel'), [multi], viewport, false)).toEqual({ kind: 'cancel' });
});

it('submits a changed answer after returning to an answered question', () => {
  const questions = [multi, single];

  const outcome = run(questions, initialState(questions), [
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
      { question: 'Which features?', selected: ['Lint', 'Format'], typed: false },
      { question: 'Which library?', selected: ['Luxon'], typed: false, preview: 'luxon()' },
    ],
  });
});

it('keeps an answer when the user only moves through a multi-select question', () => {
  const questions = [multi, single];

  const outcome = run(questions, initialState(questions), [
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
      { question: 'Which features?', selected: ['Lint'], typed: false },
      { question: 'Which library?', selected: ['Luxon'], typed: false, preview: 'luxon()' },
    ],
  });
});

it('keeps a single-select answer when a key does not move the cursor', () => {
  const questions = [single, multi];

  const outcome = run(questions, initialState(questions), [
    press('enter'),
    press('previousQuestion'),
    press('up'),
    press('nextQuestion'),
    press('space'),
    press('enter'),
  ]);

  expect(outcome).toEqual({
    kind: 'submit',
    answers: [
      { question: 'Which library?', selected: ['Luxon'], typed: false, preview: 'luxon()' },
      { question: 'Which features?', selected: ['Lint'], typed: false },
    ],
  });
});

const layout: QuestionFacts = {
  question: 'Which layout?',
  multiSelect: false,
  options: [
    { label: 'Stacked', preview: 'a\nb\nc\nd\ne' },
    { label: 'Split', preview: 'x' },
  ],
};

it.each([
  { rule: 'Ctrl+O opens the full preview at the top', keys: [press('preview')], offset: 0 },
  {
    rule: 'Ctrl+O closes the full preview',
    keys: [press('preview'), press('preview')],
    offset: undefined,
  },
  {
    rule: 'Esc closes the full preview without cancelling',
    keys: [press('preview'), press('cancel')],
    offset: undefined,
  },
  { rule: 'down scrolls the full preview', keys: [press('preview'), press('down')], offset: 1 },
  {
    rule: 'down stops at the last page',
    keys: [press('preview'), press('down'), press('down'), press('down')],
    offset: 2,
  },
  { rule: 'End jumps to the last page', keys: [press('preview'), press('bottom')], offset: 2 },
  { rule: 'up stops at the top', keys: [press('preview'), press('up')], offset: 0 },
  {
    rule: 'Enter does nothing in the full preview',
    keys: [press('preview'), press('down'), press('enter')],
    offset: 1,
  },
])('$rule', ({ keys, offset }) => {
  const outcome = run([layout], at([layout], 0), keys);
  const fullPreview = offset === undefined ? undefined : { offset };

  expect(outcome).toMatchObject({ kind: 'update', state: { fullPreview } });
});

it('ignores Ctrl+O on an option without a preview', () => {
  const state = at([single], 1);

  expect(handleKey(state, press('preview'), [single], viewport, false)).toEqual({
    kind: 'update',
    state,
  });
});

it('does not type Ctrl+O into the custom row', () => {
  const state = at([single], 2, { customText: 'date' });

  expect(handleKey(state, press('preview'), [single], viewport, false)).toEqual({
    kind: 'update',
    state,
  });
});

it('keeps the answers when the full preview closes', () => {
  const questions = [layout, single];

  const outcome = run(questions, at(questions, 0), [
    press('enter'),
    press('previousQuestion'),
    press('preview'),
    press('cancel'),
    press('nextQuestion'),
    press('enter'),
  ]);

  expect(outcome).toEqual({
    kind: 'submit',
    answers: [
      { question: 'Which layout?', selected: ['Stacked'], typed: false, preview: 'a\nb\nc\nd\ne' },
      { question: 'Which library?', selected: ['Luxon'], typed: false, preview: 'luxon()' },
    ],
  });
});

it('scrolls up from the last page after the terminal grows', () => {
  const state = { ...at([layout], 0), fullPreview: { offset: 4 } };

  expect(handleKey(state, press('up'), [layout], viewport, false)).toEqual({
    kind: 'update',
    state: { ...state, fullPreview: { offset: 1 } },
  });
});

it('scrolls the full preview by its wrapped rows', () => {
  const state = { ...at([layout], 0), fullPreview: { offset: 0 } };

  expect(handleKey(state, press('bottom'), [layout], { rows: 3, lineCount: 8 }, false)).toEqual({
    kind: 'update',
    state: { ...state, fullPreview: { offset: 5 } },
  });
});

// With a notice waiting, one more row sits below the custom row.
const withAction = (question: QuestionFacts, state: QuestionnaireState, key: KeyPress) =>
  handleKey(state, key, [question], viewport, true);

it('does not move the cursor below the custom row while no notice waits', () => {
  const state = at([single], 2);

  expect(handleKey(state, press('down', false), [single], viewport, false)).toEqual({
    kind: 'update',
    state,
  });
});

it('moves the cursor to the action row below the custom row', () => {
  const outcome = withAction(single, at([single], 2), press('down', false));

  expect(outcome).toMatchObject({ kind: 'update', state: { questions: [{ cursor: 3 }] } });
});

it.each([
  { rule: 'single-select', question: single },
  { rule: 'multi-select', question: multi },
])('defers on Enter at the action row in $rule', ({ question }) => {
  const state = at([question], question.options.length + 1, { checked: [0] });

  expect(withAction(question, state, press('enter'))).toEqual({ kind: 'defer' });
});

it('keeps the checked options when Space hits the action row', () => {
  const state = at([multi], 4, { checked: [1] });

  expect(withAction(multi, state, press('space'))).toEqual({ kind: 'update', state });
});

const answeredThenAction = (label: string, cursor: number, back: KeyPress) => {
  const answer = { question: single.question, selected: [label], typed: false };
  const state = { ...at([single], cursor), answers: [answer] };
  const onAction = withAction(single, state, press('bottom'));

  if (onAction.kind !== 'update') {
    throw new Error('The cursor move did not update.');
  }

  return { answer, onAction, back: withAction(single, onAction.state, back) };
};

it('keeps a saved single-select answer when the cursor moves onto the action row and back', () => {
  const { answer, onAction, back } = answeredThenAction('Luxon', 0, press('top'));

  expect(onAction.state.answers).toEqual([answer]);
  expect(back).toMatchObject({ kind: 'update', state: { answers: [answer] } });
});

it('reopens a single-select answer when the cursor leaves the action row for another option', () => {
  const { back } = answeredThenAction('Temporal', 1, press('top'));

  expect(back).toMatchObject({ kind: 'update', state: { answers: [undefined] } });
});

it('does not type into the custom field on the action row', () => {
  const outcome = withAction(single, at([single], 3), press('other'));

  expect(outcome).toMatchObject({ kind: 'update' });
});

it('cancels with Esc at the action row', () => {
  expect(withAction(single, at([single], 3), press('cancel'))).toEqual({ kind: 'cancel' });
});

it('moves a restored cursor off the action row and closes the full preview', () => {
  const saved = { ...at([single], 3), fullPreview: { offset: 1 } };
  const restored = restoredState(saved, [single]);

  expect(restored.questions[0]?.cursor).toBe(2);
  expect(restored.fullPreview).toBeUndefined();
});

it('moves a restored cursor off the action row to the saved single-select answer', () => {
  const answer = { question: single.question, selected: ['Temporal'], typed: false };
  const saved = { ...at([single], 3), answers: [answer] };

  expect(restoredState(saved, [single]).questions[0]?.cursor).toBe(1);
});

const recommendedSecond: QuestionFacts = {
  question: 'Which layout?',
  multiSelect: false,
  preview: 'draft',
  options: [
    { label: 'Stacked' },
    { label: 'Split', recommended: true },
    { label: 'Tabs', preview: 'tabs' },
  ],
};

it.each([
  { rule: 'the recommended option', questions: [recommendedSecond], cursor: 1 },
  { rule: 'the first option without a recommendation', questions: [single, multi], cursor: 0 },
])('opens the cursor on $rule', ({ questions, cursor }) => {
  expect(initialState(questions).questions[0]?.cursor).toBe(cursor);
});

it('keeps the saved cursor of a restored state', () => {
  const saved = at([recommendedSecond], 2);

  expect(restoredState(saved, [recommendedSecond]).questions[0]?.cursor).toBe(2);
});

it.each([
  { rule: 'the question preview', cursor: 0, preview: 'draft' },
  { rule: 'the question preview of a recommended option', cursor: 1, preview: 'draft' },
  { rule: 'the own preview of an option', cursor: 2, preview: 'tabs' },
])('returns $rule in the answer', ({ cursor, preview }) => {
  const outcome = handleKey(
    at([recommendedSecond], cursor),
    press('enter'),
    [recommendedSecond],
    viewport,
    false,
  );

  expect(outcome).toMatchObject({ kind: 'submit', answers: [{ preview }] });
});

it('opens the full preview of the question on an option without one', () => {
  const outcome = handleKey(
    at([recommendedSecond], 0),
    press('preview'),
    [recommendedSecond],
    viewport,
    false,
  );

  expect(outcome).toMatchObject({ kind: 'update', state: { fullPreview: { offset: 0 } } });
});

it.each([
  { rule: 'an option in single-select', question: single, state: at([single], 0) },
  {
    rule: 'a checked option in multi-select',
    question: multi,
    state: at([multi], 1, { checked: [0] }),
  },
  {
    rule: 'the custom row with text',
    question: multi,
    state: at([multi], 3, { customText: 'Docs' }),
  },
])('answers with Enter on $rule while a notice waits', ({ question, state }) => {
  expect(handleKey(state, press('enter'), [question], viewport, true).kind).toBe('submit');
});

it('stays on the question when Enter has nothing to answer', () => {
  const questions = [multi, single];
  const state = initialState(questions);

  expect(handleKey(state, press('enter'), questions, viewport, false)).toEqual({
    kind: 'update',
    state,
  });
});

const answerOf = (question: QuestionFacts, label: string) => ({
  question: question.question,
  selected: [label],
  typed: false,
});

it('asks again when the user moves a single-select cursor onto the custom row', () => {
  const questions = [single, multi];

  const outcome = run(questions, initialState(questions), [
    press('enter'),
    press('previousQuestion'),
    press('bottom'),
    press('nextQuestion'),
    press('space'),
    press('enter'),
  ]);

  expect(outcome).toMatchObject({ kind: 'update', state: { tab: 0 } });
});

it('asks again when the typed text of an answered question changes', () => {
  const state = { ...at([single], 2), answers: [answerOf(single, 'Luxon')] };

  expect(withCustomText(state, 'Docs').answers).toEqual([undefined]);
});

it('keeps the answer when the typed text stays the same', () => {
  const state = {
    ...at([single], 2, { customText: 'Docs' }),
    answers: [answerOf(single, 'Luxon')],
  };

  expect(withCustomText(state, 'Docs').answers).toEqual(state.answers);
});

it('does not check an option on a key that is not Space', () => {
  const outcome = handleKey(at([multi], 1), press('other'), [multi], viewport, false);

  expect(outcome.kind === 'update' && outcome.state.questions[0]?.checked).toEqual([]);
});

it('moves the cursor of a restored typed answer to the custom row', () => {
  const typed = { question: single.question, selected: ['Docs'], typed: true };
  const saved = { ...at([single], 3, { customText: 'Docs' }), answers: [typed] };

  expect(restoredState(saved, [single]).questions[0]?.cursor).toBe(2);
});

const three: QuestionFacts[] = ['One?', 'Two?', 'Three?'].map((question) => ({
  question,
  multiSelect: false,
  options: [{ label: 'A' }, { label: 'B' }],
}));

it.each([
  { key: 'nextQuestion', from: 0, tab: 1 },
  { key: 'nextQuestion', from: 2, tab: 0 },
  { key: 'previousQuestion', from: 0, tab: 2 },
  { key: 'previousQuestion', from: 2, tab: 1 },
] as const)('moves from question $from to $tab with $key among three', ({ key, from, tab }) => {
  const state = { ...initialState(three), tab: from };

  expect(handleKey(state, press(key), three, viewport, false)).toMatchObject({
    kind: 'update',
    state: { tab },
  });
});

it.each(['nextQuestion', 'previousQuestion'] as const)(
  'switches questions with %s on the custom row instead of typing',
  (key) => {
    const state = at(three, 2, { customText: 'Docs' });
    const outcome = handleKey(state, press(key), three, viewport, false);

    expect(outcome.kind).toBe('update');
  },
);

it('goes on to the next question that has no answer', () => {
  const outcome = run(three, initialState(three), [
    press('nextQuestion'),
    press('enter'),
    press('nextQuestion'),
    press('enter'),
  ]);

  expect(outcome).toMatchObject({ kind: 'update', state: { tab: 2 } });
});
