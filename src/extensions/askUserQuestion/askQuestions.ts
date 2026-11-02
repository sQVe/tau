import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { customWithBlockedStatus } from '../../dialog/blockedStatus.js';
import { questionDialog } from './dialog.js';
import type { DialogQuestion, DialogResult, DialogSession } from './dialog.js';
import type { Answer, QuestionnaireState } from './questionnaire.js';
import { refuseUnrepliedTypedAnswer } from './typedAnswerReply.js';
import { validateQuestions } from './validation.js';

type QuestionInput = Omit<DialogQuestion, 'multiSelect'> & { multiSelect?: boolean };

interface QuestionResponse {
  content: { type: 'text'; text: string }[];
  details: DialogResult;
}

type AskQuestions = (
  input: QuestionInput[],
  context: ExtensionContext,
) => Promise<QuestionResponse>;

const answerSegment = (answer: Answer) => {
  const preview = answer.preview === undefined ? '' : ` selected preview: ${answer.preview}.`;

  return `"${answer.question}"="${answer.selected.join(', ')}".${preview}`;
};

const typedAnswerEnding =
  'The user typed a free-text answer. If it asks a question or asks for an explanation, answer it in visible text first, then end your turn. Do not call ask_user_question in the same message.';

const responseText = (result: DialogResult) => {
  if (result.kind === 'declined') {
    return 'User declined to answer questions. Closing the dialog is not approval. State the blocked decision and stop. Do not ask the same question again in prose.';
  }

  if (result.kind === 'deferred') {
    return "User chose to handle a waiting worker notice first. No question was answered and nothing is approved. Handle the waiting notice, then call ask_user_question again with the same questions. The dialog restores the user's selections.";
  }

  const segments = result.answers.map(answerSegment).join(' ');
  const typed = result.answers.some((answer) => answer.typed);

  const ending = typed
    ? typedAnswerEnding
    : "You can now continue with the user's answers in mind.";

  return `User has answered your questions: ${segments} ${ending}`;
};

// The model can repeat the same questions with their properties in another order.
const questionsKey = (questions: DialogQuestion[]): string =>
  JSON.stringify(
    questions.map((question) => [
      question.question,
      question.problem,
      question.impact,
      question.preview ?? null,
      question.header,
      question.multiSelect,
      question.options.map((option) => [
        option.label,
        option.description,
        option.recommended === true,
        option.preview ?? null,
      ]),
    ]),
  );

export const createQuestionAsker = (subscribe: DialogSession['subscribe']): AskQuestions => {
  // Only the latest deferred dialog is kept. Other questions asked in between leave it in place.
  let deferred: { key: string; state: QuestionnaireState } | undefined;

  return async (input, context) => {
    // `hasUI` is also true in RPC mode, where `ui.custom` resolves without running a component.
    if (context.mode !== 'tui') {
      throw new Error('The questionnaire needs the terminal UI. Ask in plain text instead.');
    }

    refuseUnrepliedTypedAnswer(context.sessionManager);

    validateQuestions(input);

    const questions = input.map((question) => ({
      ...question,
      multiSelect: question.multiSelect === true,
    }));

    const key = questionsKey(questions);
    const saved = deferred?.key === key ? deferred.state : undefined;

    const session = {
      saved,
      subscribe,
      save: (state: QuestionnaireState) => {
        deferred = { key, state };
      },
    };

    if (saved !== undefined) {
      deferred = undefined;
    }

    const opened = await customWithBlockedStatus<DialogResult | undefined>(
      context,
      { kind: 'question', message: questions[0]?.header ?? '' },
      questionDialog(questions, session),
    );

    const result: DialogResult = opened ?? { kind: 'declined' };

    return { content: [{ type: 'text', text: responseText(result) }], details: result };
  };
};
