import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';

import {
  cutOverBudget,
  decideBudgetRefusal,
  describeCutItems,
  raiseOutputCap,
  readOutputBudget,
} from './codemodeBudget.js';
import { saveFullOutput } from './saveFullOutput.js';

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
    const texts = items.flatMap((item) => (item.type === 'text' ? [item.text] : []));
    const choice = cutOverBudget(texts, tokens);

    if (choice === undefined) {
      return undefined;
    }

    const path = await saveFullOutput('tau-codemode-', texts.join('\n')).catch(() => undefined);
    let seen = 0;

    const content = items.filter((item) => {
      if (item.type !== 'text') {
        return true;
      }

      seen += 1;

      return seen <= choice.kept;
    });

    const gap = { type: 'text' as const, text: describeCutItems(choice.cut, path) };

    return { content: [...header, ...content, gap] };
  });

  return checkCall;
};
