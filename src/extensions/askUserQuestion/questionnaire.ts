export interface QuestionFacts {
  question: string;
  multiSelect: boolean;
  // Shown for every option without a preview of its own.
  preview?: string;
  options: { label: string; recommended?: boolean; preview?: string }[];
}

export type KeyPress =
  | { kind: 'up' | 'down' | 'top' | 'bottom'; typed: boolean }
  | {
      kind:
        | 'space'
        | 'enter'
        | 'nextQuestion'
        | 'previousQuestion'
        | 'preview'
        | 'cancel'
        | 'other';
    };

export interface Answer {
  question: string;
  selected: string[];
  typed: boolean;
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
  // Set while the focused option's preview fills the dialog, scrolled down by `offset` lines.
  fullPreview: { offset: number } | undefined;
}

// The full preview shows `rows` of the focused preview's `lineCount` rows after wrapping.
export interface PreviewViewport {
  rows: number;
  lineCount: number;
}

export type KeyOutcome =
  | { kind: 'update'; state: QuestionnaireState }
  | { kind: 'type' }
  | { kind: 'submit'; answers: Answer[] }
  | { kind: 'cancel' }
  | { kind: 'defer' };

// The preview shown while the cursor is on an option row. The custom and action rows show none.
export const shownPreview = (facts: QuestionFacts, row: number): string | undefined => {
  const option = facts.options[row];

  return option === undefined ? undefined : (option.preview ?? facts.preview);
};

// The cursor opens on the recommended option, or on the first option when none is recommended.
const openingCursor = (facts: QuestionFacts): number =>
  Math.max(
    0,
    facts.options.findIndex((option) => option.recommended === true),
  );

export const initialState = (questions: readonly QuestionFacts[]): QuestionnaireState => ({
  tab: 0,
  questions: questions.map((facts) => ({
    cursor: openingCursor(facts),
    checked: [],
    customText: '',
  })),
  answers: questions.map(() => undefined),
  fullPreview: undefined,
});

// Saved state comes from a dialog that had notices. The new dialog has none, so a cursor on the
// action row moves back to the custom row, and a full preview closes.
// The cursor row of a saved single-select answer. A typed answer sits on the custom row.
const answeredRow = (facts: QuestionFacts, answer: Answer | undefined): number | undefined => {
  if (facts.multiSelect || answer === undefined) {
    return undefined;
  }

  const index = facts.options.findIndex((option) => option.label === answer.selected[0]);

  return index === -1 ? facts.options.length : index;
};

const restoredCursor = (facts: QuestionFacts, cursor: number, answer: Answer | undefined) => {
  const customRow = facts.options.length;

  if (cursor <= customRow) {
    return cursor;
  }

  return answeredRow(facts, answer) ?? customRow;
};

export const restoredState = (
  saved: QuestionnaireState,
  questions: readonly QuestionFacts[],
): QuestionnaireState => ({
  ...saved,
  fullPreview: undefined,
  questions: saved.questions.map((question, index) => {
    const facts = questions[index];
    const answer = saved.answers[index];
    const cursor = facts === undefined ? 0 : restoredCursor(facts, question.cursor, answer);

    return { ...question, cursor };
  }),
});

export const isCustomChecked = (text: string): boolean => text.trim() !== '';

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

export const withCustomText = (state: QuestionnaireState, text: string): QuestionnaireState => {
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

    const typed = customText !== '';

    return selected.length === 0 ? undefined : { question: facts.question, selected, typed };
  }

  const option = facts.options[question.cursor];

  if (option === undefined) {
    return customText === ''
      ? undefined
      : { question: facts.question, selected: [customText], typed: true };
  }

  const shown = shownPreview(facts, question.cursor);
  const preview = shown === undefined ? {} : { preview: shown };

  return { question: facts.question, selected: [option.label], typed: false, ...preview };
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
  deferAvailable: boolean,
): KeyOutcome => {
  const customRow = facts.options.length;
  const lastRow = deferAvailable ? customRow + 1 : customRow;

  const cursors: Partial<Record<KeyPress['kind'], number>> = {
    up: Math.max(0, question.cursor - 1),
    down: Math.min(lastRow, question.cursor + 1),
    top: 0,
    bottom: lastRow,
  };

  const cursor = cursors[key.kind];

  // The cursor picks the answer only in single-select. The action row is never an answer, so a
  // saved answer stays while the cursor is on it and when the cursor returns to the answered row.
  if (cursor !== undefined) {
    const moved = withQuestion(state, { cursor });
    const staysOnAnswer = cursor === answeredRow(facts, state.answers[state.tab]);
    const keepsAnswer = facts.multiSelect || cursor > customRow || staysOnAnswer;

    return { kind: 'update', state: keepsAnswer ? moved : reopened(moved) };
  }

  if (key.kind === 'space' && facts.multiSelect && question.cursor <= customRow) {
    const checked = toggle(question.checked, question.cursor);

    return { kind: 'update', state: reopened(withQuestion(state, { checked })) };
  }

  return { kind: 'update', state };
};

// Ctrl+O never types: an option without a preview, such as the custom row, ignores it.
const openPreview = (state: QuestionnaireState, preview: string | undefined): KeyOutcome => {
  if (preview === undefined) {
    return { kind: 'update', state };
  }

  return { kind: 'update', state: { ...state, fullPreview: { offset: 0 } } };
};

const scrollPreview = (
  state: QuestionnaireState,
  key: KeyPress,
  viewport: PreviewViewport,
): KeyOutcome => {
  const lastOffset = Math.max(0, viewport.lineCount - viewport.rows);
  // A taller terminal can leave the saved offset past the last page.
  const offset = Math.min(state.fullPreview?.offset ?? 0, lastOffset);

  const offsets: Partial<Record<KeyPress['kind'], number>> = {
    up: Math.max(0, offset - 1),
    down: Math.min(lastOffset, offset + 1),
    top: 0,
    bottom: lastOffset,
  };

  const next = offsets[key.kind];

  if (next === undefined) {
    return { kind: 'update', state };
  }

  return { kind: 'update', state: { ...state, fullPreview: { offset: next } } };
};

// Esc leaves the full preview instead of cancelling the questionnaire.
const handlePreviewKey = (
  state: QuestionnaireState,
  key: KeyPress,
  viewport: PreviewViewport,
): KeyOutcome => {
  if (key.kind === 'preview' || key.kind === 'cancel') {
    return { kind: 'update', state: { ...state, fullPreview: undefined } };
  }

  return scrollPreview(state, key, viewport);
};

const handleListKey = (
  state: QuestionnaireState,
  key: KeyPress,
  facts: QuestionFacts,
  question: QuestionState,
  deferAvailable: boolean,
): KeyOutcome => {
  if (key.kind === 'cancel') {
    return { kind: 'cancel' };
  }

  if (key.kind === 'enter' && deferAvailable && question.cursor > facts.options.length) {
    return { kind: 'defer' };
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

  return handleOptionKey(state, key, facts, question, deferAvailable);
};

/**
 * The last row of each question is the custom text row, which returns `type` for keys the caller
 * should pass to its text input. `viewport` describes the focused option's full preview. While
 * `deferAvailable`, one more row below the custom row defers instead of answering.
 */
export const handleKey = (
  state: QuestionnaireState,
  key: KeyPress,
  questions: readonly QuestionFacts[],
  viewport: PreviewViewport,
  deferAvailable: boolean,
): KeyOutcome => {
  const facts = questions[state.tab];
  const question = state.questions[state.tab];

  if (facts === undefined || question === undefined) {
    return key.kind === 'cancel' ? { kind: 'cancel' } : { kind: 'update', state };
  }

  const preview = shownPreview(facts, question.cursor);

  if (state.fullPreview !== undefined && preview !== undefined) {
    return handlePreviewKey(state, key, viewport);
  }

  if (key.kind === 'preview') {
    return openPreview(state, preview);
  }

  return handleListKey(state, key, facts, question, deferAvailable);
};
