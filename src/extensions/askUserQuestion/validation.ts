export interface QuestionInput {
  question: string;
  context: string;
  options: readonly { label: string; recommended?: boolean; preview?: string }[];
}

const reservedLabels = new Set(['Other', 'Type something.']);

const isBlank = (text: string) => text.trim() === '';

const validateContext = (question: QuestionInput) => {
  if (isBlank(question.context)) {
    throw new Error(`Question "${question.question}" needs a context.`);
  }

  if (question.context.trim() === question.question.trim()) {
    throw new Error(
      `The context of "${question.question}" repeats the question. Say what is being decided and what the answer changes.`,
    );
  }
};

const validatePreviews = (question: QuestionInput) => {
  const previews = question.options.map((option) => option.preview);

  if (previews.some((preview) => preview !== undefined && isBlank(preview))) {
    throw new Error(`A preview of "${question.question}" is blank. Remove it or show content.`);
  }

  const withPreview = previews.filter((preview) => preview !== undefined).length;

  if (withPreview > 0 && withPreview < previews.length) {
    throw new Error(
      `Give every option of "${question.question}" a preview, or none. For an option such as "Keep as is", show the unchanged state.`,
    );
  }
};

const validateRecommendation = (question: QuestionInput) => {
  const recommended = question.options.filter((option) => option.recommended === true);

  if (recommended.length > 1) {
    throw new Error(`Set recommended: true on at most one option of "${question.question}".`);
  }

  // The dialog focuses the first option, and short terminals can hide the others.
  if (recommended.length === 1 && question.options[0]?.recommended !== true) {
    throw new Error(`Put the recommended option of "${question.question}" first.`);
  }
};

const validateOptions = (question: QuestionInput) => {
  const labels = question.options.map((option) => option.label);

  if (labels.some((label) => reservedLabels.has(label))) {
    throw new Error(`Option label is reserved (${[...reservedLabels].join(', ')}).`);
  }

  if (labels.some((label) => /\(recommended\)/iu.test(label))) {
    throw new Error(
      'Set `recommended: true` on the option instead of "(Recommended)" in its label.',
    );
  }

  if (new Set(labels).size !== labels.length) {
    throw new Error('Option labels must be unique within a question.');
  }
};

export const validateQuestions = (questions: readonly QuestionInput[]): void => {
  const texts = questions.map((question) => question.question);

  if (new Set(texts).size !== texts.length) {
    throw new Error('Question text must be unique within an invocation.');
  }

  for (const question of questions) {
    validateContext(question);
    validateOptions(question);
    validateRecommendation(question);
    validatePreviews(question);
  }
};
