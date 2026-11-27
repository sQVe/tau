import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';

import { isRecord } from '../../schema.js';

export const handoverSendTarget = (event: ToolCallEvent): string | undefined => {
  if (event.toolName !== 'handover' || !isRecord(event.input)) {
    return undefined;
  }

  const { action, terminal } = event.input;

  if (action !== 'send' || typeof terminal !== 'string') {
    return undefined;
  }

  return terminal;
};

export const handoverTargetRefusal = (
  target: string | undefined,
  leadTerminal: string | null | undefined,
): string | undefined => {
  if (target === undefined || leadTerminal === null || leadTerminal === undefined) {
    return undefined;
  }

  if (leadTerminal === '' || target === leadTerminal) {
    return undefined;
  }

  return `Blocked handover send to ${target}. Send the handover to the lead terminal ${leadTerminal}.`;
};
