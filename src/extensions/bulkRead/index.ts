import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { resolveDelegate } from '../../delegateModel/index.js';
import { bulkReadInputError, bulkReadTool, bulkRead } from './tool.js';

// ADR 0014 records the measurement behind this threshold.
export const bulkReadLineThreshold = 400;

// Recoverable failures say nothing about whether the delegate is reachable, so trimming stays on.
const recoverableErrors = new Set(['AbortError', 'TimeoutError', bulkReadInputError]);

export const rewriteContinuationNotice = (text: string): string =>
  text.replace(
    /\n\n\[(?:(\d+) more lines in file\. Use offset=(\d+)|Showing lines \d+-(\d+) of (\d+)(?: \([^)]*limit\))?\. Use offset=\d+) to continue\.\]$/,
    (
      _notice,
      remainingCount: string | undefined,
      nextOffset: string | undefined,
      shownEnd: string | undefined,
      totalLines: string | undefined,
    ) => {
      const start = remainingCount === undefined ? Number(shownEnd) + 1 : Number(nextOffset);
      const end =
        remainingCount === undefined ? Number(totalLines) : start + Number(remainingCount) - 1;
      const remaining = end - start + 1;
      const guidance =
        remaining > bulkReadLineThreshold
          ? 'For questions, call bulk_read with paths and question. To edit, use a bounded read with offset and limit.'
          : `Read with offset=${start} and limit=${remaining} to continue.`;

      return `\n\nLines ${start}-${end} remain. ${guidance}`;
    },
  );

// A throwing registry would escape the hook and block the read itself, so clamping falls back to
// stock behavior instead. The tool path still reports the error.
const clampDelegate = (ctx: ExtensionContext) => {
  try {
    return resolveDelegate(ctx);
  } catch {
    return undefined;
  }
};

export default function bulkReadExtension(pi: ExtensionAPI): void {
  let trimming = true;
  const clamped = new Set<string>();
  const description =
    'Ask a cheaper model for focused summaries, test inventories, and line-cited evidence from supplied files, not correctness or branch review judgments.';

  pi.registerTool({
    name: bulkReadTool,
    label: 'Bulk read',
    description,
    promptSnippet: description,
    promptGuidelines: [
      'Use bulk_read summaries for navigation without rereading files. Verify only consequential claims before edits or reports using bounded reads. Integration claims need production callers.',
      'For bulk_read-based branch judgments, including alleged regressions, inspect the actual diff and applicable project rules. Distinguish inherited code from changes.',
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      question: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const model = resolveDelegate(ctx);

        return await bulkRead(ctx, model, params, signal);
      } catch (error) {
        if (!(error instanceof Error) || !recoverableErrors.has(error.name)) {
          trimming = false;
        }

        throw error;
      }
    },
  });

  pi.on('tool_call', (event, ctx) => {
    if (!trimming || !isToolCallEventType('read', event) || event.input.limit !== undefined) {
      return;
    }

    if (!clampDelegate(ctx)) {
      trimming = false;

      return;
    }

    event.input.limit = bulkReadLineThreshold;
    clamped.add(event.toolCallId);
  });

  // The extension outlives a session, but ADR 0014 scopes a stopped trim to the session that
  // stopped it.
  const resetSession = () => {
    trimming = true;
    clamped.clear();
  };

  pi.on('session_start', resetSession);
  pi.on('session_before_switch', () => {
    resetSession();

    return undefined;
  });
  pi.on('session_before_fork', () => {
    resetSession();

    return undefined;
  });

  pi.on('tool_result', (event) => {
    if (!clamped.delete(event.toolCallId)) {
      return undefined;
    }

    return {
      content: event.content.map((part) =>
        part.type === 'text' ? { ...part, text: rewriteContinuationNotice(part.text) } : part,
      ),
    };
  });
}
