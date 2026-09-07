import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type { ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent';

export const commitGuardReason = 'Blocked git commit via bash. Use the `commit` tool instead.';

// Allow options between `git` and `commit`, but stop at command separators and exclude paths.
// Accept `commit-` to catch commit-tree, also blocking commit-graph and `git log --grep commit`.
// These false positives favor blocking; variable indirection (`g=git; $g commit`) bypasses this.
const gitCommitPattern = /\bgit\b[^;|&\n]*(?<![\w/-])commit(?![\w/])|\bgit-commit\b/i;

// Normalize common shell spellings such as `g\it c''ommit` before matching.
const unescapeShellWord = (command: string) =>
  command.replaceAll('\\\n', '').replaceAll(/\\(.)/gs, '$1').replaceAll(/''|""/g, '');

export const guardToolCall = (event: ToolCallEvent): ToolCallEventResult | undefined => {
  if (!isToolCallEventType('bash', event)) {
    return undefined;
  }

  if (gitCommitPattern.test(unescapeShellWord(event.input.command))) {
    return { block: true, reason: commitGuardReason };
  }

  return undefined;
};
