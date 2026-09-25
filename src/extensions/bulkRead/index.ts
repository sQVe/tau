import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { resolveDelegate } from '../../delegateModel/index.js';
import { BulkReadRecoverableError, bulkReadTool, bulkRead, isCancellation } from './tool.js';

interface BulkReadState {
  trimming: boolean;
  clamped: Set<string>;
}

// ADR 0014 records the measurement behind this threshold.
const bulkReadLineThreshold = 400;

// Cancellations and timeouts, like recoverable bulk read failures, say nothing about the delegate.
const isRecoverable = (error: unknown): boolean =>
  error instanceof BulkReadRecoverableError || isCancellation(error);

const bulkReadDescription =
  'Ask a cheaper model for focused summaries, test inventories, and line-cited evidence from supplied files, not correctness or branch review judgments.';

const buildContinuationNotice = (_match: string, ...groups: (string | undefined)[]): string => {
  const [remainingCount, nextOffset, shownEnd, totalLines] = groups;
  const start = remainingCount === undefined ? Number(shownEnd) + 1 : Number(nextOffset);

  const end =
    remainingCount === undefined ? Number(totalLines) : start + Number(remainingCount) - 1;

  const remaining = end - start + 1;

  const guidance =
    remaining > bulkReadLineThreshold
      ? 'For questions, call bulk_read with paths and question. To edit, use a bounded read with offset and limit.'
      : `Read with offset=${start} and limit=${remaining} to continue.`;

  return `\n\nLines ${start}-${end} remain. ${guidance}`;
};

export const rewriteContinuationNotice = (text: string): string =>
  text.replace(
    /\n\n\[(?:(\d+) more lines in file\. Use offset=(\d+)|Showing lines \d+-(\d+) of (\d+)(?: \([^)]*limit\))?\. Use offset=\d+) to continue\.\]$/,
    buildContinuationNotice,
  );

// A throwing registry would escape the hook and block the read itself, so clamping falls back to
// stock behavior instead. The tool path still reports the error.
const clampDelegate = (context: ExtensionContext) => {
  try {
    return resolveDelegate(context);
  } catch {
    return undefined;
  }
};

const registerBulkRead = (pi: ExtensionAPI, state: BulkReadState): void => {
  pi.registerTool({
    name: bulkReadTool,
    label: 'Bulk read',
    description: bulkReadDescription,
    promptSnippet: bulkReadDescription,
    promptGuidelines: [
      'Use bulk_read summaries for navigation without rereading files. Verify only consequential claims before edits or reports using bounded reads. Integration claims need production callers.',
      'For bulk_read-based branch judgments, including alleged regressions, inspect the actual diff and applicable project rules. Distinguish inherited code from changes.',
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      question: Type.String({ minLength: 1 }),
    }),
    // eslint-disable-next-line eslint/max-params -- Pi calls execute with five positional arguments.
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      try {
        const model = resolveDelegate(context);

        return await bulkRead(context, model, params, signal);
      } catch (error) {
        if (!isRecoverable(error)) {
          state.trimming = false;
        }

        throw error;
      }
    },
  });
};

const registerTrimHook = (pi: ExtensionAPI, state: BulkReadState): void => {
  pi.on('tool_call', (event, context) => {
    if (!state.trimming || !isToolCallEventType('read', event) || event.input.limit !== undefined) {
      return;
    }

    if (!clampDelegate(context)) {
      state.trimming = false;

      return;
    }

    event.input.limit = bulkReadLineThreshold;
    state.clamped.add(event.toolCallId);
  });
};

const rewriteToolResult = (
  state: BulkReadState,
  event: Pick<ToolResultEvent, 'toolCallId' | 'content'>,
) => {
  if (!state.clamped.delete(event.toolCallId)) {
    return undefined;
  }

  return {
    content: event.content.map((part) =>
      part.type === 'text' ? { ...part, text: rewriteContinuationNotice(part.text) } : part,
    ),
  };
};

export default function bulkReadExtension(pi: ExtensionAPI): void {
  const state: BulkReadState = { trimming: true, clamped: new Set() };

  registerBulkRead(pi, state);
  registerTrimHook(pi, state);

  // The extension outlives a session, but ADR 0014 scopes a stopped trim to the session that
  // stopped it.
  const resetSession = () => {
    state.trimming = true;
    state.clamped.clear();
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

  pi.on('tool_result', (event) => rewriteToolResult(state, event));
}
