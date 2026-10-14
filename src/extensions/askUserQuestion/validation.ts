export interface QuestionInput {
  question: string;
  problem: string;
  impact: string;
  preview?: string;
  options: readonly { label: string; recommended?: boolean; preview?: string }[];
}

const reservedLabels = new Set(['Other', 'Type something.']);

const isBlank = (text: string) => text.trim() === '';

const validateProblem = (question: QuestionInput) => {
  if (isBlank(question.problem)) {
    throw new Error(`Question "${question.question}" needs a problem.`);
  }

  if (isBlank(question.impact)) {
    throw new Error(`Question "${question.question}" needs an impact.`);
  }

  if (question.problem.trim() === question.question.trim()) {
    throw new Error(
      `The problem of "${question.question}" repeats the question. Say what is going on.`,
    );
  }

  if (question.problem.trim() === question.impact.trim()) {
    throw new Error(
      `The problem of "${question.question}" equals its impact. Say what the answer changes or blocks in the impact.`,
    );
  }
};

const validatePreviews = (question: QuestionInput) => {
  const previews = [question.preview, ...question.options.map((option) => option.preview)];

  if (previews.some((preview) => preview !== undefined && isBlank(preview))) {
    throw new Error(`A preview of "${question.question}" is blank. Remove it or show content.`);
  }
};

const validateRecommendation = (question: QuestionInput) => {
  const recommended = question.options.filter((option) => option.recommended === true);

  if (recommended.length > 1) {
    throw new Error(`Set recommended: true on at most one option of "${question.question}".`);
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
    validateProblem(question);
    validateOptions(question);
    validateRecommendation(question);
    validatePreviews(question);
  }
};
