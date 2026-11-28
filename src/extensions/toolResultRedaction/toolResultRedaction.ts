import type {
  ExtensionAPI,
  ToolResultEvent,
  ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';

import { redactToolResult, secretValues } from './redaction.js';

const withheldResult = (event: ToolResultEvent): ToolResultEventResult => {
  const result: ToolResultEventResult = {
    content: [
      { type: 'text', text: 'Tau withheld this tool result because secret redaction failed.' },
    ],
    details: {},
    isError: true,
  };

  if (event.structuredContent !== undefined) {
    result.structuredContent = {};
  }

  return result;
};

export default function toolResultRedaction(pi: ExtensionAPI): void {
  pi.on('tool_result', (event) => {
    try {
      // oxlint-disable-next-line node/no-process-env -- Redaction matches the values the tools can see.
      return redactToolResult(event, secretValues(process.env));
    } catch {
      return withheldResult(event);
    }
  });
}
