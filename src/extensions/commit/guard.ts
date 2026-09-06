import { isToolCallEventType } from '@mariozechner/pi-coding-agent';
import type { ToolCallEvent, ToolCallEventResult } from '@mariozechner/pi-coding-agent';

export const commitGuardReason = 'Blocked git commit via bash. Use the `commit` tool instead.';

// Matches `commit` reached from `git` without crossing a command separator, so option forms like
// `git -C path commit` are caught along with env prefixes and wrappers. `commit` must stand alone
// as a word, otherwise every git command naming a path under commit/ would be blocked. A trailing
// backslash keeps a line continuation inside the span. Deliberately over-blocks mentions such as
// `git log --grep commit`: a wrongly blocked call costs one retry, while a missed one defeats the
// guard. Indirection through a variable (`g=git; $g commit`) is beyond a regex and stays unguarded.
const gitCommitPattern = /\bgit\b(?:[^;|&\n]|\\\n)*(?<![\w/-])commit(?![\w/-])|\bgit-commit\b/i;

export const guardToolCall = (event: ToolCallEvent): ToolCallEventResult | undefined => {
  if (!isToolCallEventType('bash', event)) {
    return undefined;
  }

  if (gitCommitPattern.test(event.input.command)) {
    return { block: true, reason: commitGuardReason };
  }

  return undefined;
};
