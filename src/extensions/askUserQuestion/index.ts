import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { appendToolGuidelines } from '../../systemPrompt/index.js';
import { questionDialog } from './dialog.js';
import type { DialogResult } from './dialog.js';
import type { Answer } from './questionnaire.js';

type QuestionParams = Static<typeof questionParams>;

const reservedLabels = new Set(['Other', 'Type something.']);

const optionSchema = Type.Object({
  label: Type.String({
    maxLength: 60,
    description:
      'MAX 60 CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.',
  }),
  description: Type.String({
    description:
      'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.',
  }),
  preview: Type.Optional(
    Type.String({
      description:
        'Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.',
    }),
  ),
});

const questionSchema = Type.Object({
  question: Type.String({
    description:
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
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
    description: 'Questions to ask the user (1-4 questions)',
  }),
});

const toolDescription = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. A typed answer is returned together with the checked options.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content renders as preformatted text below the option list while its option is focused. Multi-line text with newlines is supported. Do not use previews for simple preference questions where labels and descriptions suffice.`;

const promptGuidelines = [
  "Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to 4 questions per invocation.",
  'Each question MUST have 2-4 options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. Do NOT author "Other" or "Type something." labels yourself.',
  'Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.',
];

const validate = ({ questions }: QuestionParams) => {
  const texts = questions.map((question) => question.question);

  if (new Set(texts).size !== texts.length) {
    throw new Error('Question text must be unique within an invocation.');
  }

  for (const question of questions) {
    const labels = question.options.map((option) => option.label);

    if (labels.some((label) => reservedLabels.has(label))) {
      throw new Error(`Option label is reserved (${[...reservedLabels].join(', ')}).`);
    }

    if (new Set(labels).size !== labels.length) {
      throw new Error('Option labels must be unique within a question.');
    }
  }
};

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

export default function askUserQuestionExtension(pi: ExtensionAPI) {
  appendToolGuidelines(pi, 'ask_user_question', promptGuidelines);

  pi.registerTool({
    name: 'ask_user_question',
    label: 'Ask User Question',
    description: toolDescription,
    promptSnippet:
      'Ask the user up to 4 structured questions (2-4 options each) when requirements are ambiguous',
    parameters: questionParams,

    // eslint-disable-next-line eslint/max-params -- Pi calls execute with five positional arguments.
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      // `hasUI` is also true in RPC mode, where `ui.custom` resolves without running a component.
      if (context.mode !== 'tui') {
        throw new Error('The questionnaire needs the terminal UI. Ask in plain text instead.');
      }

      validate(params);

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
