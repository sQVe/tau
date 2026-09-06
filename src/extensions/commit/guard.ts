import { isToolCallEventType } from '@mariozechner/pi-coding-agent';
import type { ToolCallEvent, ToolCallEventResult } from '@mariozechner/pi-coding-agent';

export const commitGuardReason = 'Blocked git commit via bash. Use the `commit` tool instead.';

// Matches `commit` reached from `git` without crossing a command separator, so option forms like
// `git -C path commit` are caught along with env prefixes and wrappers. Deliberately over-blocks
// mentions such as `git log --grep commit`: a wrongly blocked call costs one retry, while a missed
// one defeats the guard.
const gitCommitPattern = /\bgit\b[^;|&\n]*\bcommit\b|\bgit-commit\b/i;

export const guardToolCall = (event: ToolCallEvent): ToolCallEventResult | undefined => {
  if (!isToolCallEventType('bash', event)) {
    return undefined;
  }

  if (gitCommitPattern.test(event.input.command)) {
    return { block: true, reason: commitGuardReason };
  }

  return undefined;
};
