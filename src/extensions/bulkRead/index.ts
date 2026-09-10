import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { BULK_READ_TOOL, bulkRead } from './tool.js';

// ponytail: unmeasured. Seeded at 400 because the delegate's input is 50x cheaper, so early trimming
// costs latency, not money. Revise from the measurement table in docs/development.md.
export const BULK_READ_LINE_THRESHOLD = 400;

export const delegateReference = (): string =>
  process.env.TAU_BULK_READ_MODEL ?? 'openai-codex/gpt-5.6-luna';

export const rewriteContinuationNotice = (text: string): string | undefined => {
  const notice = /\n\n\[[^\n]*Use offset=\d+ to continue\.\]$/;
  if (!notice.test(text)) {
    return undefined;
  }

  return text.replace(
    notice,
    `\n\nFile continues past line ${BULK_READ_LINE_THRESHOLD}. For a question about this file call bulk_read with paths and question. To edit, read again with offset and limit.`,
  );
};

export const isHardFailure = (result: AgentToolResult<unknown> | Error): boolean => {
  if (result instanceof Error) {
    return result.name !== 'AbortError' && result.name !== 'TimeoutError';
  }

  return (
    typeof result.details === 'object' &&
    result.details !== null &&
    'hardFailure' in result.details &&
    result.details.hardFailure === true
  );
};

const findDelegate = (ctx: ExtensionContext, reference: string) => {
  const separator = reference.indexOf('/');
  if (separator <= 0 || separator === reference.length - 1) {
    return undefined;
  }

  return ctx.modelRegistry.find(reference.slice(0, separator), reference.slice(separator + 1));
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
      const reference = delegateReference();
      const model = findDelegate(ctx, reference);
      if (!model) {
        trimming = false;

        return {
          content: [
            {
              type: 'text',
              text: `Bulk read ${reference} failed: model not found or invalid provider/id reference. Check pi --list-models.`,
            },
          ],
          details: { isError: true, hardFailure: true },
          isError: true,
        };
      }

      const result = await bulkRead(ctx, model, params, signal);
      if (isHardFailure(result)) {
        trimming = false;
      }

      return result;
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
    // Pi ignores isError returned by execute; the result hook must set the message flag.
    if (
      event.toolName === BULK_READ_TOOL &&
      typeof event.details === 'object' &&
      event.details !== null &&
      'isError' in event.details &&
      event.details.isError === true
    ) {
      return { isError: true };
    }
    if (!clamped.delete(event.toolCallId)) {
      return undefined;
    }

    const index = event.content.findLastIndex((part) => part.type === 'text');
    const part = event.content[index];
    if (part?.type !== 'text') {
      return undefined;
    }

    const text = rewriteContinuationNotice(part.text);
    if (text === undefined) {
      return undefined;
    }

    const content = [...event.content];
    content[index] = { ...part, text };

    return { content };
  });
}
