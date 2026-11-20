import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { customWithBlockedStatus } from '../../dialog/blockedStatus.js';
import { questionDialog } from './dialog.js';
import type { DialogQuestion, DialogResult } from './dialog.js';
import type { Answer } from './questionnaire.js';
import type { ShadowJob, ShadowQuestion, ShadowRunner } from './shadow.js';
import { refuseUnrepliedTypedAnswer } from './typedAnswerReply.js';
import { validateQuestions } from './validation.js';

type QuestionInput = Omit<DialogQuestion, 'multiSelect'> & {
  multiSelect?: boolean;
  kind?: 'choice' | 'approval';
  confidence?: number;
};

type OpenQuestionDialog = ReturnType<typeof questionDialog>;

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

const sessionIdOf = (sessionManager: ExtensionContext['sessionManager']): string | undefined => {
  try {
    const sessionId = sessionManager.getSessionId();

    return sessionId === '' ? undefined : sessionId;
  } catch {
    return undefined;
  }
};

const shadowQuestionsOf = (input: readonly QuestionInput[]): ShadowQuestion[] =>
  input.map((question) => ({
    question: question.question,
    problem: question.problem,
    impact: question.impact,
    kind: question.kind,
    confidence: question.confidence,
    multiSelect: question.multiSelect === true,
    preview: question.preview,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
      recommended: option.recommended === true,
      preview: option.preview,
    })),
  }));

export const askQuestions = async (
  input: QuestionInput[],
  context: ExtensionContext,
  shadow: ShadowRunner,
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

  const open = questionDialog(questions);
  const shadowQuestions = shadowQuestionsOf(input);

  let job: ShadowJob | undefined;

  const openWithShadow: OpenQuestionDialog = (terminal, theme, keybindings, done) => {
    const settle = (result: DialogResult) => {
      job?.settle(result);
      done(result);
    };

    const dialog = open(terminal, theme, keybindings, settle);
    const sessionId = sessionIdOf(context.sessionManager);

    if (sessionId !== undefined) {
      job = shadow.start({
        questions: shadowQuestions,
        sessionId,
        cwd: context.cwd,
        projectTrusted: context.isProjectTrusted(),
        registry: context.modelRegistry,
      });
    }

    return dialog;
  };

  try {
    const opened = await customWithBlockedStatus<DialogResult | undefined>(
      context,
      { kind: 'question', message: questions[0]?.header ?? '' },
      openWithShadow,
    );

    const result: DialogResult = opened ?? { kind: 'declined' };

    return { content: [{ type: 'text', text: responseText(result) }], details: result };
  } catch (error) {
    job?.abort();

    throw error;
  }
};
