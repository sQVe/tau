export interface QuestionFacts {
  question: string;
  multiSelect: boolean;
  options: { label: string; preview?: string }[];
}

export type KeyPress =
  | { kind: 'up' | 'down' | 'top' | 'bottom'; typed: boolean }
  | { kind: 'space' | 'enter' | 'nextQuestion' | 'previousQuestion' | 'cancel' | 'other' };

export interface Answer {
  question: string;
  selected: string[];
  preview?: string;
}

interface QuestionState {
  cursor: number;
  checked: number[];
  customText: string;
}

export interface QuestionnaireState {
  tab: number;
  questions: QuestionState[];
  answers: (Answer | undefined)[];
}

export type KeyOutcome =
  | { kind: 'update'; state: QuestionnaireState }
  | { kind: 'type' }
  | { kind: 'submit'; answers: Answer[] }
  | { kind: 'cancel' };

export const initialState = (count: number): QuestionnaireState => ({
  tab: 0,
  questions: Array.from({ length: count }, () => ({ cursor: 0, checked: [], customText: '' })),
  answers: Array.from({ length: count }, () => undefined),
});

export const isCustomChecked = (text: string) => text.trim() !== '';

const withQuestion = (
  state: QuestionnaireState,
  change: Partial<QuestionState>,
): QuestionnaireState => {
  const question = state.questions[state.tab];

  if (question === undefined) {
    return state;
  }

  return { ...state, questions: state.questions.with(state.tab, { ...question, ...change }) };
};

// A changed answer must be entered again, so its saved form is never submitted.
const reopened = (state: QuestionnaireState): QuestionnaireState => ({
  ...state,
  answers: state.answers.with(state.tab, undefined),
});

export const withCustomText = (state: QuestionnaireState, text: string) => {
  const unchanged = state.questions[state.tab]?.customText === text;
  const updated = withQuestion(state, { customText: text });

  return unchanged ? updated : reopened(updated);
};

const toggle = (checked: number[], index: number) =>
  checked.includes(index) ? checked.filter((item) => item !== index) : [...checked, index];

const answerFor = (facts: QuestionFacts, question: QuestionState): Answer | undefined => {
  const customText = question.customText.trim();

  if (facts.multiSelect) {
    const selected = facts.options
      .filter((_option, index) => question.checked.includes(index))
      .map((option) => option.label);

    if (customText !== '') {
      selected.push(customText);
    }

    return selected.length === 0 ? undefined : { question: facts.question, selected };
  }

  const option = facts.options[question.cursor];

  if (option === undefined) {
    return customText === '' ? undefined : { question: facts.question, selected: [customText] };
  }

  const preview = option.preview === undefined ? {} : { preview: option.preview };

  return { question: facts.question, selected: [option.label], ...preview };
};

const nextUnanswered = (answers: (Answer | undefined)[], tab: number) => {
  const order = [...answers.keys()].map((offset) => (tab + 1 + offset) % answers.length);

  return order.find((index) => answers[index] === undefined);
};

const submit = (
  state: QuestionnaireState,
  facts: QuestionFacts,
  question: QuestionState,
): KeyOutcome => {
  const answer = answerFor(facts, question);

  if (answer === undefined) {
    return { kind: 'update', state };
  }

  const answers = state.answers.with(state.tab, answer);
  const tab = nextUnanswered(answers, state.tab);

  if (tab === undefined) {
    return { kind: 'submit', answers: answers.filter((item) => item !== undefined) };
  }

  return { kind: 'update', state: { ...state, answers, tab } };
};

// The custom row is a text field: it types every key except the ones that leave it or finish.
const typesText = (key: KeyPress) => {
  if (key.kind === 'up' || key.kind === 'down') {
    return key.typed;
  }

  return key.kind !== 'enter' && key.kind !== 'nextQuestion' && key.kind !== 'previousQuestion';
};

const switchQuestion = (state: QuestionnaireState, step: number): KeyOutcome => {
  const count = state.questions.length;

  return { kind: 'update', state: { ...state, tab: (state.tab + step + count) % count } };
};

const handleOptionKey = (
  state: QuestionnaireState,
  key: KeyPress,
  facts: QuestionFacts,
  question: QuestionState,
): KeyOutcome => {
  const lastRow = facts.options.length;

  const cursors: Partial<Record<KeyPress['kind'], number>> = {
    up: Math.max(0, question.cursor - 1),
    down: Math.min(lastRow, question.cursor + 1),
    top: 0,
    bottom: lastRow,
  };

  const cursor = cursors[key.kind];

  // The cursor picks the answer only in single-select.
  if (cursor !== undefined) {
    const moved = withQuestion(state, { cursor });

    return { kind: 'update', state: facts.multiSelect ? moved : reopened(moved) };
  }

  if (key.kind === 'space' && facts.multiSelect) {
    const checked = toggle(question.checked, question.cursor);

    return { kind: 'update', state: reopened(withQuestion(state, { checked })) };
  }

  return { kind: 'update', state };
};

/**
 * The last row of each question is the custom text row, which returns `type` for keys the caller
 * should pass to its text input.
 */
export const handleKey = (
  state: QuestionnaireState,
  key: KeyPress,
  questions: readonly QuestionFacts[],
): KeyOutcome => {
  const facts = questions[state.tab];
  const question = state.questions[state.tab];

  if (key.kind === 'cancel') {
    return { kind: 'cancel' };
  }

  if (facts === undefined || question === undefined) {
    return { kind: 'update', state };
  }

  if (question.cursor === facts.options.length && typesText(key)) {
    return { kind: 'type' };
  }

  if (key.kind === 'enter') {
    return submit(state, facts, question);
  }

  if (key.kind === 'nextQuestion' || key.kind === 'previousQuestion') {
    return switchQuestion(state, key.kind === 'nextQuestion' ? 1 : -1);
  }

  return handleOptionKey(state, key, facts, question);
};
