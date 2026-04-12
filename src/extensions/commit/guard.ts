import { isToolCallEventType } from '@mariozechner/pi-coding-agent';
import type { ToolCallEvent, ToolCallEventResult } from '@mariozechner/pi-coding-agent';

import { findGitCommits, parseBash } from './shell/index.js';

export const commitGuardReason = 'Blocked git commit via bash. Use the `commit` tool instead.';

const shellEvalPrefixes = ['sh -c', 'bash -c'] as const;
const shellEvalCommitNeedles = ['git commit', 'git-commit'] as const;

const extractQuotedEvalPayloads = (command: string) => {
  const normalized = command.toLowerCase();
  const payloads: string[] = [];

  for (const prefix of shellEvalPrefixes) {
    let searchStart = 0;

    for (;;) {
      const prefixIndex = normalized.indexOf(prefix, searchStart);
      if (prefixIndex === -1) {
        break;
      }

      const payloadStart = prefixIndex + prefix.length;
      const quoteIndex = [payloadStart, payloadStart + 1].find(
        (index) => command[index] === "'" || command[index] === '"',
      );

      if (quoteIndex !== undefined) {
        const quote = command[quoteIndex];
        if (quote === undefined) {
          searchStart = payloadStart;
          continue;
        }

        const payloadEnd = command.indexOf(quote, quoteIndex + 1);
        if (payloadEnd !== -1) {
          payloads.push(command.slice(quoteIndex + 1, payloadEnd).toLowerCase());
          searchStart = payloadEnd + 1;
          continue;
        }
      }

      searchStart = payloadStart;
    }
  }

  return payloads;
};

const containsEvalBypassCommit = (command: string) => {
  const payloads = extractQuotedEvalPayloads(command);
  return payloads.some((payload) =>
    shellEvalCommitNeedles.some((needle) => payload.includes(needle)),
  );
};

export const guardToolCall = async (
  event: ToolCallEvent,
): Promise<ToolCallEventResult | undefined> => {
  if (!isToolCallEventType('bash', event)) {
    return undefined;
  }

  if (containsEvalBypassCommit(event.input.command)) {
    return { block: true, reason: commitGuardReason };
  }

  try {
    const ast = await parseBash(event.input.command);
    if (findGitCommits(ast).length === 0) {
      return undefined;
    }

    return { block: true, reason: commitGuardReason };
  } catch {
    return undefined;
  }
};
