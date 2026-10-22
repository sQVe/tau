import type { BeforeAgentStartEvent, ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Pi-claude-bridge forwards the append section but drops a replaced prompt, tool guidelines, and
// sections. Pi sends direct providers an unchanged section once per session.
export const appendSystemPrompt = (event: BeforeAgentStartEvent, text: string): void => {
  const options = event.systemPromptOptions;

  options.appendSystemPrompt = options.appendSystemPrompt
    ? `${options.appendSystemPrompt}\n\n${text}`
    : text;
};

// Use instead of a tool's `promptGuidelines`, which Pi renders only into the default prompt.
export const appendToolGuidelines = (
  pi: Pick<ExtensionAPI, 'on'>,
  toolName: string,
  guidelines: readonly string[],
): void => {
  pi.on('before_agent_start', (event) => {
    if (guidelines.length > 0 && event.systemPromptOptions.selectedTools.includes(toolName)) {
      appendSystemPrompt(event, guidelines.map((guideline) => `- ${guideline}`).join('\n'));
    }
  });
};
