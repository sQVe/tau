import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { customWithBlockedStatus } from '../../dialog/blockedStatus.js';
import type { DecideQuestion, Decider } from './decide.js';
import { questionDialog } from './dialog.js';
import type { DialogQuestion, DialogResult } from './dialog.js';
import type { Answer } from './questionnaire.js';
import type { ShadowJob, ShadowRunner } from './shadow.js';
import { refuseUnrepliedTypedAnswer } from './typedAnswerReply.js';
import { validateQuestions } from './validation.js';

type QuestionInput = Omit<DialogQuestion, 'multiSelect'> & {
  multiSelect?: boolean;
  kind?: 'choice' | 'approval';
  confidence?: number;
};

type OpenQuestionDialog = ReturnType<typeof questionDialog>;

type QuestionResult = DialogResult | { kind: 'decided'; answers: Answer[]; record: string };

interface QuestionResponse {
  content: { type: 'text'; text: string }[];
  details: QuestionResult;
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

const decidedText = (notice: string) =>
  `The question gate answered this call instead of the user:\n${notice}\nThis is not the user's answer. It never approves publishing, pushing, or posting.`;

const sessionIdOf = (sessionManager: ExtensionContext['sessionManager']): string | undefined => {
  try {
    const sessionId = sessionManager.getSessionId();

    return sessionId === '' ? undefined : sessionId;
  } catch {
    return undefined;
  }
};

const nonEmptyQuestions = (
  questions: readonly DecideQuestion[],
): [DecideQuestion, ...DecideQuestion[]] | undefined => {
  const [first, ...rest] = questions;

  return first === undefined ? undefined : [first, ...rest];
};

export const askQuestions = async (
  input: QuestionInput[],
  context: ExtensionContext,
  shadow: ShadowRunner,
  decider: Decider,
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

  const sessionId = sessionIdOf(context.sessionManager);
  const decideQuestions = nonEmptyQuestions(questions);

  const prepared =
    decideQuestions === undefined
      ? undefined
      : decider.prepare({
          questions: decideQuestions,
          sessionId,
          cwd: context.cwd,
          projectTrusted: context.isProjectTrusted(),
          registry: context.modelRegistry,
          notify: (text) => {
            context.ui.notify(text, 'info');
          },
        });

  const decision = prepared === undefined ? undefined : await prepared.run();

  if (decision?.kind === 'decided') {
    return {
      content: [{ type: 'text', text: decidedText(decision.notice) }],
      details: { kind: 'decided', answers: decision.answers, record: decision.record },
    };
  }

  const open = questionDialog(questions);

  let job: ShadowJob | undefined;

  const openWithShadow: OpenQuestionDialog = (terminal, theme, keybindings, done) => {
    const settle = (result: DialogResult) => {
      job?.settle(result);
      done(result);
    };

    const dialog = open(terminal, theme, keybindings, settle);

    if (sessionId !== undefined) {
      job = shadow.start({
        questions,
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

    job?.settle(result);

    return { content: [{ type: 'text', text: responseText(result) }], details: result };
  } catch (error) {
    job?.abort();

    throw error;
  }
};
