import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { BULK_READ_INPUT_ERROR, BULK_READ_TOOL, bulkRead } from './tool.js';

// ponytail: seeded at 400 and kept after the 2026-09-10 measurement in docs/development.md, which
// found the saving inside run-to-run variance. Revisit when the delegate or session model changes.
export const BULK_READ_LINE_THRESHOLD = 400;

// Recoverable failures say nothing about whether the delegate is reachable, so trimming stays on.
const RECOVERABLE_ERRORS = new Set(['AbortError', 'TimeoutError', BULK_READ_INPUT_ERROR]);

export const delegateReference = (): string => {
  // eslint-disable-next-line node/no-process-env -- ADR 0013 defines the delegate environment setting.
  const reference = process.env.TAU_BULK_READ_MODEL;

  // An exported but empty setting means unset, so it takes the default rather than a missing model.
  return reference == null || reference === '' ? 'openai-codex/gpt-5.6-luna' : reference;
};

export const rewriteContinuationNotice = (text: string): string =>
  text.replace(
    /\n\n\[[^\n]*Use offset=(\d+) to continue\.\]$/,
    '\n\nFile continues at line $1. For a question about this file call bulk_read with paths and question. To edit, read again with offset and limit.',
  );

const findDelegate = (ctx: ExtensionContext, reference: string) => {
  const [provider, ...id] = reference.split('/');

  return ctx.modelRegistry.find(provider ?? '', id.join('/'));
};

export default function bulkReadExtension(pi: ExtensionAPI): void {
  let trimming = true;
  const clamped = new Set<string>();
  const description =
    'Ask a cheaper model a question about one or more large files instead of reading them.';

  pi.registerTool({
    name: BULK_READ_TOOL,
    label: 'Bulk read',
    description,
    promptSnippet: description,
    parameters: Type.Object({
      paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      question: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const reference = delegateReference();
        const model = findDelegate(ctx, reference);
        if (!model) {
          throw new Error(
            `Bulk read ${reference} failed: model not found. Check pi --list-models.`,
          );
        }

        return await bulkRead(ctx, model, params, signal);
      } catch (error) {
        if (!(error instanceof Error) || !RECOVERABLE_ERRORS.has(error.name)) {
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
    if (!findDelegate(ctx, delegateReference())) {
      trimming = false;

      return;
    }

    event.input.limit = BULK_READ_LINE_THRESHOLD;
    clamped.add(event.toolCallId);
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
