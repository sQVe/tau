import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type { ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent';

import { typesIntoTerminal } from './guardDecision.js';

export const terminalTypingReason =
  'Blocked typing into a terminal with `hc send` or `hc keys`. Send a handover with the `handover` tool action `send`, and answer a worker question with `subagent_answer`.';

export const guardTerminalTyping = (event: ToolCallEvent): ToolCallEventResult | undefined => {
  if (!isToolCallEventType('bash', event)) {
    return undefined;
  }

  if (typesIntoTerminal(event.input.command)) {
    return { block: true, reason: terminalTypingReason };
  }

  return undefined;
};
