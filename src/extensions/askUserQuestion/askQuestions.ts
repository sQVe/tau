import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { customWithBlockedStatus } from '../../dialog/blockedStatus.js';
import { questionDialog } from './dialog.js';
import type { DialogQuestion, DialogResult } from './dialog.js';
import type { Answer } from './questionnaire.js';
import { refuseUnrepliedTypedAnswer } from './typedAnswerReply.js';
import { validateQuestions } from './validation.js';

type QuestionInput = Omit<DialogQuestion, 'multiSelect'> & { multiSelect?: boolean };

interface QuestionResponse {
  content: { type: 'text'; text: string }[];
  details: DialogResult;
}

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

  const segments = result.answers.map(answerSegment).join(' ');
  const typed = result.answers.some((answer) => answer.typed);

  const ending = typed
    ? typedAnswerEnding
    : "You can now continue with the user's answers in mind.";

  return `User has answered your questions: ${segments} ${ending}`;
};

export const askQuestions = async (
  input: QuestionInput[],
  context: ExtensionContext,
): Promise<QuestionResponse> => {
  if (context.mode !== 'tui') {
    throw new Error('The questionnaire needs the terminal UI. Ask in plain text instead.');
  }

  refuseUnrepliedTypedAnswer(context.sessionManager);

  validateQuestions(input);

  const questions = input.map((question) => ({
    ...question,
    multiSelect: question.multiSelect === true,
  }));

  const opened = await customWithBlockedStatus<DialogResult | undefined>(
    context,
    { kind: 'question', message: questions[0]?.header ?? '' },
    questionDialog(questions),
  );

  const result: DialogResult = opened ?? { kind: 'declined' };

  return { content: [{ type: 'text', text: responseText(result) }], details: result };
};
