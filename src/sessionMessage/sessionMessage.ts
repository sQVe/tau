import type { SessionEntry } from '@earendil-works/pi-coding-agent';

import { isRecord, text } from '../schema.ts';

export interface CalledTool {
  callId: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface DroppedCall {
  callId: string | undefined;
  tool: string | undefined;
}

export interface AssistantCalls {
  calls: CalledTool[];
  dropped: DroppedCall[];
}

export const entryMessage = (entry: SessionEntry): Record<string, unknown> | undefined => {
  if (entry.type !== 'message') {
    return undefined;
  }

  const message: unknown = entry.message;

  return isRecord(message) ? message : undefined;
};

export const assistantCalls = (message: Record<string, unknown>): AssistantCalls => {
  const parts = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
  const found: AssistantCalls = { calls: [], dropped: [] };

  for (const part of parts.filter((candidate) => candidate.type === 'toolCall')) {
    const tool = text(part.name);
    const callId = text(part.id);

    if (tool === undefined || callId === undefined) {
      found.dropped.push({ callId, tool });
    } else {
      const parameters = isRecord(part.arguments) ? part.arguments : undefined;

      found.calls.push({
        callId,
        tool,
        ...(parameters === undefined ? {} : { arguments: parameters }),
      });
    }
  }

  return found;
};
