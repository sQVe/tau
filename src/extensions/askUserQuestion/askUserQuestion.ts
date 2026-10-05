import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { appendToolGuidelines } from '../../systemPrompt.js';
import { questionDialog } from './dialog.js';
import type { DialogResult } from './dialog.js';
import type { Answer } from './questionnaire.js';
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
        'Set on at most one option per question when you recommend it. Put that option first and say why in its description. The dialog shows a badge; do not add "(Recommended)" to the label.',
    }),
  ),
  preview: Type.Optional(
    Type.String({
      description:
        'Optional preformatted example of what this option produces, shown when the option is focused. If one option of a question has a preview, every option needs one. See the tool description.',
    }),
  ),
});

const questionSchema = Type.Object({
  question: Type.String({
    description:
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
  }),
  context: Type.String({
    maxLength: 400,
    description:
      'MAX 400 CHARACTERS. 1-3 sentences for a user who has not read your discussion: what is being decided, why it needs deciding now, and what the answer changes or blocks. Do not repeat the question.',
  }),
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
- \`context\` says what is being decided, why now, and what the answer changes or blocks.
- Each option \`description\` says what happens if chosen, then the main benefit and cost.
- Say what a thing is. Never name who proposed an option (models, agents, reviewers). Never use option letters, internal codes, or unexplained ADR or ticket numbers.

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. A typed answer is returned together with the checked options.
- If you recommend an option, put it first and set \`recommended: true\` on it. At most one option per question may be recommended. The answer returns the plain label.

Preview feature:
Add a \`preview\` to every option when the options change something you can show: a layout, a config file, a command, a code shape, output, or a draft. If one option has a preview, all options of that question need one; show the unchanged state for an option such as "Keep as is". Use the same example scenario in every preview and keep each one short, about 10 lines. Skip previews for plain preferences where the labels and descriptions suffice.

Preview content renders as preformatted text below the option list while its option is focused. The user can press Ctrl+O to see a long preview in full.

Example question:
{
  "question": "Where should the cache live?",
  "context": "Startup reads every config file, which takes 2 seconds. A cache removes that wait, and its location decides who can clear it.",
  "header": "Cache",
  "options": [
    { "label": "Project folder", "description": "Writes .cache/ next to the code. Easy to find and delete; each clone builds its own cache.", "recommended": true, "preview": "repo/\\n  .cache/config.json" },
    { "label": "Home folder", "description": "Writes ~/.cache/tool/. One cache for all clones; stale entries are harder to spot.", "preview": "~/.cache/tool/repo-hash.json" }
  ]
}`;

const promptGuidelines = [
  "Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to 4 questions per invocation.",
  'Each question MUST have 2-4 options and a context that lets a user who has not read your discussion understand it on its own. Every option requires a concise label (1-5 words) and a description of what happens if chosen and its trade-off. Do NOT author "Other" or "Type something." labels yourself.',
  'Never name who proposed an option, and never use option letters, internal codes, or unexplained ADR or ticket numbers. Say what the thing is.',
  'Ask one question by default. Group only questions that do not depend on each other. Ask a question that depends on an earlier answer after you have that answer.',
  'If the user closes the dialog without an answer, state the blocked decision and stop. Closing the dialog is not approval, and do not ask the same question again in prose.',
];

const answerSegment = (answer: Answer) => {
  const preview = answer.preview === undefined ? '' : ` selected preview: ${answer.preview}.`;

  return `"${answer.question}"="${answer.selected.join(', ')}".${preview}`;
};

const responseText = (result: DialogResult | undefined) => {
  if (result === undefined || result.cancelled) {
    return 'User declined to answer questions';
  }

  const segments = result.answers.map(answerSegment).join(' ');

  return `User has answered your questions: ${segments} You can now continue with the user's answers in mind.`;
};

export default function askUserQuestionExtension(pi: ExtensionAPI): void {
  appendToolGuidelines(pi, 'ask_user_question', promptGuidelines);

  pi.registerTool({
    name: 'ask_user_question',
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

      const result = await context.ui.custom<DialogResult | undefined>(questionDialog(questions));
      const details: DialogResult = result ?? { cancelled: true, answers: [] };

      return { content: [{ type: 'text', text: responseText(result) }], details };
    },
  });
}
