import type { ExtensionAPI, ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { saveFullOutput } from '../../saveFullOutput.js';
import { decideBashOutputCap } from './bashOutputCap.js';

const capBashOutput = async (event: ToolResultEvent) => {
  const decision = decideBashOutputCap(event);

  if (decision === undefined) {
    return undefined;
  }

  const { text, head, tail, cut } = decision;
  const path = await saveFullOutput('tau-bash-', text);
  const marker = `[${cut} of ${text.length} characters cut. Command exited with code 0. Full output: ${path}]`;

  return {
    content: [{ type: 'text' as const, text: `${head}\n\n${marker}\n\n${tail}` }],
    ...(event.structuredContent === undefined
      ? {}
      : { structuredContent: event.structuredContent }),
  };
};

export default function workerBashGuard(pi: ExtensionAPI): void {
  pi.on('tool_call', (event) => {
    if (event.toolName !== 'bash') {
      return undefined;
    }

    const command = event.input.command;

    if (typeof command !== 'string' || command.trim().length > 0) {
      return undefined;
    }

    return {
      block: true,
      reason: 'Empty bash command rejected. Send the complete command and continue your task.',
    };
  });

  pi.on('tool_result', capBashOutput);
}
