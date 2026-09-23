import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

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
}
