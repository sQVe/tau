import type { JsonObject } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { parseModelReference } from '../config/models.ts';
import { classifierTimeoutMilliseconds } from './choice.ts';
import type { ChoiceOutcome, ChoiceQuestion } from './choice.ts';

export { classifierTimeoutMilliseconds } from './choice.ts';
export type { ChoiceOutcome, ChoiceQuestion } from './choice.ts';

export const classifyChoice = async (
  context: Pick<ExtensionContext, 'modelRegistry'>,
  reference: string,
  state: JsonObject,
  question: ChoiceQuestion,
  signal: AbortSignal | undefined,
): Promise<ChoiceOutcome> => {
  if (signal?.aborted === true) {
    return { kind: 'error' };
  }

  const parsed = parseModelReference(reference);

  if (parsed === undefined) {
    return { kind: 'unavailable' };
  }

  const classifier = context.modelRegistry.findOfType('classifier', parsed.provider, parsed.id);

  if (classifier === undefined) {
    return { kind: 'unavailable' };
  }

  const controller = new AbortController();
  const stopped = Promise.withResolvers<ChoiceOutcome>();

  const stop = (outcome: ChoiceOutcome) => {
    controller.abort();
    stopped.resolve(outcome);
  };

  const timer = setTimeout(() => {
    stop({ kind: 'timeout' });
  }, classifierTimeoutMilliseconds);

  const cancel = () => {
    stop({ kind: 'error' });
  };

  signal?.addEventListener('abort', cancel, { once: true });

  try {
    const answer = context.modelRegistry
      .classify(
        classifier,
        {
          state,
          questions: {
            choice: {
              type: 'choice',
              instructions: question.instructions,
              criteria: question.criteria,
            },
          },
        },
        { signal: controller.signal },
      )
      .then((result): ChoiceOutcome => {
        const choice = result.answers.choice;

        if (result.stopReason !== 'stop' || choice?.type !== 'choice') {
          return { kind: 'error' };
        }

        return { kind: 'answered', label: choice.choice, confidence: choice.confidence };
      })
      .catch((): ChoiceOutcome => ({ kind: 'error' }));

    return await Promise.race([answer, stopped.promise]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
};
