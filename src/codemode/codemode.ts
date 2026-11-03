import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';

import { decideBudgetRefusal, raiseOutputCap, readOutputBudget } from './budget.js';
import { saveFullOutput } from './fullOutput.js';
import { cutOverBudget, describeCutItems } from './outputCuts.js';
import { splitOutput } from './outputSegments.js';

type ToolResultContent = ToolResultEvent['content'][number];

// Pi puts this header first in a codemode result. Its text items follow.
const headerCount = 1;

// Registers the result handler and returns the check for the caller's own tool_call handler.
export const registerCodemodeBudget = (
  pi: ExtensionAPI,
): ((event: ToolCallEvent) => ToolCallEventResult | undefined) => {
  const budgets = new Map<string, number>();

  const checkCall = (event: ToolCallEvent): ToolCallEventResult | undefined => {
    if (event.toolName !== 'codemode') {
      return undefined;
    }

    const input: Record<string, unknown> = event.input;
    const code = input.code;

    if (typeof code !== 'string') {
      return undefined;
    }

    const refusal = decideBudgetRefusal(code);

    if (refusal !== undefined) {
      return { block: true, reason: refusal };
    }

    budgets.set(event.toolCallId, readOutputBudget(code));
    input.code = raiseOutputCap(code);

    return undefined;
  };

  pi.on('tool_result', async (event) => {
    const tokens = budgets.get(event.toolCallId);

    if (event.toolName !== 'codemode' || tokens === undefined) {
      return undefined;
    }

    budgets.delete(event.toolCallId);

    const header = event.content.slice(0, headerCount);
    const items = event.content.slice(headerCount);

    const segments = splitOutput(
      items.map((item) => (item.type === 'text' ? item.text : undefined)),
      event.isError,
    );

    const cuttable = segments.flat().filter((segment) => segment.kind !== 'label');
    const choice = cutOverBudget(cuttable, tokens);

    if (choice === undefined) {
      return undefined;
    }

    const fullText = cuttable.map((segment) => segment.text).join('\n');
    const path = await saveFullOutput('tau-codemode-', fullText).catch(() => undefined);
    let seen = 0;

    const content = items.flatMap((item, index): ToolResultContent[] => {
      if (item.type !== 'text') {
        return [item];
      }

      const kept = (segments[index] ?? []).filter((segment) => {
        if (segment.kind !== 'label') {
          seen += 1;
        }

        return segment.kind === 'label' || seen <= choice.kept;
      });

      const text = kept
        .map((segment, position) => (position === 0 ? '' : segment.separator) + segment.text)
        .join('');

      return kept.length === 0 ? [] : [{ type: 'text', text }];
    });

    const gap = { type: 'text' as const, text: describeCutItems(choice.cut, path) };

    return { content: [...header, ...content, gap] };
  });

  return checkCall;
};
