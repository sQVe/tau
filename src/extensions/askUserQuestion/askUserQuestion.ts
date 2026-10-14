import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { appendToolGuidelines } from '../../systemPrompt.js';
import { parseWorkerNoticeEvent, workerNoticeChannel } from '../../workerNoticeEvent.js';
import { questionDialog } from './dialog.js';
import type { DialogQuestion, DialogResult, DialogSession } from './dialog.js';
import type { Answer, QuestionnaireState } from './questionnaire.js';
import { validateQuestions } from './validation.js';

const optionSchema = Type.Object({
  label: Type.String({
    maxLength: 60,
    description:
      'MAX 60 CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and say what the choice is. No option letters or internal codes.',
  }),
  description: Type.String({
    maxLength: 220,
    description:
      'MAX 220 CHARACTERS. What happens if the user picks this option, then its main benefit and main cost. Skip the cost for a harmless preference instead of inventing one.',
  }),
  recommended: Type.Optional(
    Type.Boolean({
      description:
        'Set on at most one option per question when you recommend it. Say why in its description. The dialog shows a badge; do not add "(Recommended)" to the label.',
    }),
  ),
  preview: Type.Optional(
    Type.String({
      description:
        'Optional preformatted example of what this option produces, shown when the option is focused. It replaces the question-level preview for this option. Without either, the option shows no preview. See the tool description.',
    }),
  ),
});

const questionSchema = Type.Object({
  question: Type.String({
    description:
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
  }),
  problem: Type.String({
    maxLength: 300,
    description:
      'MAX 300 CHARACTERS. What is going on, in plain words, for a user who has not read your discussion. State the situation or issue behind the decision, not the decision itself. Do not repeat the question.',
  }),
  impact: Type.String({
    maxLength: 200,
    description:
      'MAX 200 CHARACTERS. What the answer changes or blocks. Do not repeat the problem.',
  }),
  preview: Type.Optional(
    Type.String({
      description:
        'Optional preformatted content that every option acts on, such as a draft to approve. Shown for each option without its own preview. See the tool description.',
    }),
  ),
  header: Type.String({
    maxLength: 16,
    description:
      'MAX 16 CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".',
  }),
  options: Type.Array(optionSchema, {
    minItems: 2,
    maxItems: 4,
    description:
      "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The 'Type something.' row is appended automatically — do NOT author it.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.',
    }),
  ),
});

const questionParams = Type.Object({
  questions: Type.Array(questionSchema, {
    minItems: 1,
    maxItems: 4,
    description:
      'Questions to ask the user (1-4 questions). Ask one by default. Add more only when they do not depend on each other.',
  }),
});

const toolDescription = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Write for a user who returns cold. They have not read your discussion, so every question must stand alone:
- \`problem\` says what is going on, in plain words.
- \`impact\` says what the answer changes or blocks.
- Each option \`description\` says what happens if chosen, then the main benefit and cost.
- Say what a thing is. Never name who proposed an option (models, agents, reviewers). Never use option letters, internal codes, or unexplained ADR or ticket numbers.

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. A typed answer is returned together with the checked options.
- Keep options in a natural, stable order, such as the same order every time you ask the same kind of question. Set \`recommended: true\` on the option you recommend, wherever it sits. The dialog opens on it. At most one option per question may be recommended. The answer returns the plain label.

Preview feature:
Add a \`preview\` to an option when it changes something you can show: a layout, a config file, a command, a code shape, output, or a draft. Show the unchanged state for an option such as "Keep as is" when a comparison helps. An option with nothing to show, such as "Cancel", needs no preview. Use the same example scenario in every preview and keep each one short, about 10 lines. Skip previews for plain preferences where the labels and descriptions suffice.

Add a \`preview\` to the question for content every option acts on, such as a draft the user approves, publishes, or changes. Every option shows it, and an option's own \`preview\` replaces it while that option is focused.

Preview content renders as preformatted text below the option list while its option is focused. The user can press Ctrl+O to see a long preview in full.

Example question:
{
  "question": "Where should the cache live?",
  "problem": "Startup reads every config file, which takes 2 seconds. A cache would remove that wait.",
  "impact": "The cache location decides who can find and clear it.",
  "header": "Cache",
  "options": [
    { "label": "Project folder", "description": "Writes .cache/ next to the code. Easy to find and delete; each clone builds its own cache.", "recommended": true, "preview": "repo/\\n  .cache/config.json" },
    { "label": "Home folder", "description": "Writes ~/.cache/tool/. One cache for all clones; stale entries are harder to spot.", "preview": "~/.cache/tool/repo-hash.json" }
  ]
}`;

const promptGuidelines = [
  "Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to 4 questions per invocation.",
  'Each question MUST have 2-4 options and a problem and an impact that let a user who has not read your discussion understand it on their own. Every option requires a concise label (1-5 words) and a description of what happens if chosen and its trade-off. Do NOT author "Other" or "Type something." labels yourself.',
  'Never name who proposed an option, and never use option letters, internal codes, or unexplained ADR or ticket numbers. Say what the thing is.',
  'Ask one question by default. Group only questions that do not depend on each other. Ask a question that depends on an earlier answer after you have that answer.',
  'If the user closes the dialog without an answer, state the blocked decision and stop. Closing the dialog is not approval, and do not ask the same question again in prose.',
  'If the result says the user chose to handle a worker notice first, nothing was answered or approved. Handle the notice, then call ask_user_question again with the same questions. The dialog restores the earlier selections.',
];

const answerSegment = (answer: Answer) => {
  const preview = answer.preview === undefined ? '' : ` selected preview: ${answer.preview}.`;

  return `"${answer.question}"="${answer.selected.join(', ')}".${preview}`;
};

const responseText = (result: DialogResult) => {
  if (result.kind === 'declined') {
    return 'User declined to answer questions';
  }

  if (result.kind === 'deferred') {
    return "User chose to handle a waiting worker notice first. No question was answered and nothing is approved. Handle the waiting notice, then call ask_user_question again with the same questions. The dialog restores the user's selections.";
  }

  const segments = result.answers.map(answerSegment).join(' ');

  return `User has answered your questions: ${segments} You can now continue with the user's answers in mind.`;
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

export default function askUserQuestionExtension(pi: ExtensionAPI): void {
  appendToolGuidelines(pi, 'ask_user_question', promptGuidelines);

  // Only the latest deferred dialog is kept. Other questions asked in between leave it in place.
  let deferred: { key: string; state: QuestionnaireState } | undefined;

  const subscribe: DialogSession['subscribe'] = (listener) =>
    pi.events.on(workerNoticeChannel, (data) => {
      const notice = parseWorkerNoticeEvent(data);

      if (notice !== undefined) {
        listener(notice);
      }
    });

  pi.registerTool({
    name: 'ask_user_question',
    exposure: 'model-only',
    label: 'Ask User Question',
    description: toolDescription,
    promptSnippet:
      'Ask the user up to 4 structured questions (2-4 options each) when requirements are ambiguous',
    parameters: questionParams,

    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      // `hasUI` is also true in RPC mode, where `ui.custom` resolves without running a component.
      if (context.mode !== 'tui') {
        throw new Error('The questionnaire needs the terminal UI. Ask in plain text instead.');
      }

      validateQuestions(params.questions);

      const questions = params.questions.map((question) => ({
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

      const opened = await context.ui.custom<DialogResult | undefined>(
        questionDialog(questions, session),
      );

      const result: DialogResult = opened ?? { kind: 'declined' };

      return { content: [{ type: 'text', text: responseText(result) }], details: result };
    },
  });
}
