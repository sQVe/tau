import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

interface ToolResultOptions {
  terminate?: boolean;
  isError?: boolean;
}

export const toolResult = <Details>(
  text: string,
  details: Details,
  options: ToolResultOptions = {},
): AgentToolResult<Details> => ({
  content: [{ type: 'text' as const, text }],
  details,
  ...options,
});
