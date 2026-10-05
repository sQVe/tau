import { getAgentDir, isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { resolveAllowedModel } from '../../models/models.js';
import { appendToolGuidelines } from '../../systemPrompt.js';
import { requireBulkReadModel } from './config.js';
import { BulkReadRecoverableError, bulkReadTool, bulkRead, isCancellation } from './tool.js';

interface BulkReadState {
  trimming: boolean;
  clamped: Set<string>;
}

// Repeat the bulk read measurement in docs/development.md before changing this threshold.
const bulkReadLineThreshold = 400;

// Cancellations and timeouts, like recoverable bulk read failures, say nothing about the bulk_read model.
const isRecoverable = (error: unknown): boolean =>
  error instanceof BulkReadRecoverableError || isCancellation(error);

export const bulkReadGuidelines = [
  'Use bulk_read summaries for navigation without rereading files. Verify only consequential claims before edits or reports using bounded reads. Integration claims need production callers.',
  'For bulk_read-based branch judgments, including alleged regressions, inspect the actual diff and applicable project rules. Distinguish inherited code from changes.',
];

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

const resolveBulkReadModel = (context: ExtensionContext) => {
  const reference = requireBulkReadModel({
    cwd: context.cwd,
    agentDirectory: getAgentDir(),
    projectTrusted: context.isProjectTrusted(),
  });

  return resolveAllowedModel(context, reference);
};

// A missing or broken model config would escape the hook and block the read itself, so clamping
// falls back to stock behavior instead. The tool path still reports the error.
const canClamp = (context: ExtensionContext): boolean => {
  try {
    resolveBulkReadModel(context);

    return true;
  } catch {
    return false;
  }
};

// The tool stays registered so worker profiles that list it still start. Tau loads after a worker's
// command-line extensions, so this runs after the worker sets its profile tools.
const hideUnusableBulkRead = (pi: ExtensionAPI, context: ExtensionContext): void => {
  if (canClamp(context)) {
    return;
  }

  const active = pi.getActiveTools();

  if (active.includes(bulkReadTool)) {
    pi.setActiveTools(active.filter((tool) => tool !== bulkReadTool));
  }
};

const registerBulkRead = (pi: ExtensionAPI, state: BulkReadState): void => {
  pi.registerTool({
    name: bulkReadTool,
    label: 'Bulk read',
    description: bulkReadDescription,
    promptSnippet: bulkReadDescription,
    parameters: Type.Object({
      paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      question: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      try {
        const model = resolveBulkReadModel(context);

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

    if (!canClamp(context)) {
      state.trimming = false;

      return;
    }

    event.input.limit = bulkReadLineThreshold;
    state.clamped.add(event.toolCallId);
  });
};

const rewriteToolResult = (
  state: BulkReadState,
  event: Pick<ToolResultEvent, 'toolCallId' | 'content' | 'structuredContent'>,
) => {
  if (!state.clamped.delete(event.toolCallId)) {
    return undefined;
  }

  return {
    content: event.content.map((part) =>
      part.type === 'text' ? { ...part, text: rewriteContinuationNotice(part.text) } : part,
    ),
    ...(event.structuredContent === undefined
      ? {}
      : { structuredContent: event.structuredContent }),
  };
};

export default function bulkReadExtension(pi: ExtensionAPI): void {
  const state: BulkReadState = { trimming: true, clamped: new Set() };

  registerBulkRead(pi, state);
  appendToolGuidelines(pi, bulkReadTool, bulkReadGuidelines);
  registerTrimHook(pi, state);

  // The extension outlives a session, but a stopped trim applies only to the session that stopped
  // it.
  const resetSession = () => {
    state.trimming = true;
    state.clamped.clear();
  };

  pi.on('session_start', (_event, context) => {
    resetSession();
    hideUnusableBulkRead(pi, context);
  });

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
