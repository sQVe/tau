import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { askQuestions } from './askQuestions.js';
import { createDecider } from './decide.js';
import type { DecidePorts } from './decide.js';
import { createShadowRunner } from './shadow.js';
import type { ShadowPorts } from './shadow.js';

export interface AskUserQuestionOptions {
  shadow?: Partial<ShadowPorts>;
  decide?: Partial<DecidePorts>;
}

const optionSchema = Type.Object({
  label: Type.String({
    maxLength: 60,
    description:
      'MAX 60 CHARACTERS (hard limit). The display text for this option that the user will see and select. Should be concise (1-5 words) and say what the choice is. No option letters or internal codes.',
  }),
  description: Type.String({
    maxLength: 220,
    description:
      'MAX 220 CHARACTERS (hard limit). What happens if the user picks this option, then its main benefit and main cost. Skip the cost for a harmless preference instead of inventing one.',
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
      'MAX 300 CHARACTERS (hard limit). What is going on, in plain words, for a user who has not read your discussion. State the situation or issue behind the decision, not the decision itself. Do not repeat the question.',
  }),
  impact: Type.String({
    maxLength: 200,
    description:
      'MAX 200 CHARACTERS (hard limit). What the answer changes or blocks. Do not repeat the problem.',
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
      'MAX 16 CHARACTERS (hard limit). Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".',
  }),
  kind: Type.Optional(
    Type.Union([Type.Literal('choice'), Type.Literal('approval')], {
      description:
        'Set "choice" only for a design or process choice. Set "approval" when the user authorizes an action. A question without kind is valid and is never sampled.',
    }),
  ),
  confidence: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description:
        'Optional confidence from 0 to 1 that the user picks your recommended option. Use it with a recommendation.',
    }),
  ),
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

const toolDescription = `Ask structured questions only when a decision blocks you. Ask one by default. Group only independent questions.

Write for a user new to your discussion. \`problem\`, \`impact\`, and each option \`description\` must stand alone. Never name who proposed an option. Use no option letters, codes, or unexplained ADR or ticket numbers. Keep options stable.

- Every question gets a "Type something." row. Do not author it or "Other".
- Set \`recommended: true\` on at most one option per question.
- Set \`kind\` to "choice" for a design or process choice, "approval" for authorization; without it, valid and never sampled.
- Set \`confidence\` 0-1 with a recommendation.
- Set \`multiSelect: true\` when several answers can be valid. A typed answer keeps checked options.
- Add \`preview\` to an option to show its output, about 10 lines. Add it to the question for shared content, such as a draft to approve. An option preview replaces it.
- In decide mode, Tau may answer an eligible \`choice\`; the result says so.`;

export default function askUserQuestionExtension(
  pi: ExtensionAPI,
  options: AskUserQuestionOptions = {},
): void {
  const shadow = createShadowRunner(options.shadow);
  const decider = createDecider(options.decide);

  pi.registerTool({
    name: 'ask_user_question',
    exposure: 'model-only',
    label: 'Ask User Question',
    description: toolDescription,
    promptSnippet:
      'Ask the user up to 4 structured questions (2-4 options each) when requirements are ambiguous',
    parameters: questionParams,

    async execute(_toolCallId, params, signal, _onUpdate, context) {
      return askQuestions(params.questions, context, shadow, decider, signal);
    },
  });
}
