import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { checkSteps, planStepSchema, planEntryType, planRecord, planSummary } from './steps.js';
import { drawPlan } from './widget.js';

const parameters = Type.Object({ steps: Type.Array(planStepSchema) });

export const planToolGuidelines = [
  'Call `plan` when a request needs three or more of your own steps, such as briefing a worker, reviewing its change, and committing.',
  'Send the whole list on each `plan` call, with at most one step `in_progress`.',
  'Mark a step `completed` in `plan` as soon as it is done.',
  'Name a ticket in a `plan` step by its identifier. Never copy its state, acceptance, or design into the plan.',
  'Send `plan` an empty list when the user drops the work.',
];

export const createPlanTool = (
  pi: Pick<ExtensionAPI, 'appendEntry'>,
): ToolDefinition<typeof parameters, undefined> =>
  defineTool({
    name: 'plan',
    label: 'Plan',
    description: `Check and save the lead's plan for this session. Send the whole list on every call; it replaces the saved plan.
- Returns one line, such as "Plan: 2 of 5 completed." or "Plan cleared." for an empty list.
- Refuses more than 12 steps, a step with no text, or more than one step in_progress. A refused call saves nothing and returns the reason.
- The plan is session display state. Keep ticket state, acceptance, and design in the tracker, not in a step.`,
    promptSnippet: 'Save the lead plan as a short list of steps with one step in progress.',
    parameters,
    exposure: 'model-only',
    executionMode: 'sequential',
    execute(_toolCallId, { steps }, _signal, _onUpdate, context) {
      const checked = checkSteps(steps);

      if (checked.kind === 'refused') {
        return Promise.reject(new Error(checked.reason));
      }

      pi.appendEntry(planEntryType, planRecord(steps));
      drawPlan(context, steps);

      return Promise.resolve({
        content: [{ type: 'text' as const, text: planSummary(steps) }],
        details: undefined,
      });
    },
  });
