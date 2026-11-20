import { contentText } from '@earendil-works/pi-ai';
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsApiStreamOptions,
} from '@earendil-works/pi-ai';

import type { PanelMember } from './questionGate.ts';

interface PanelCompletion {
  complete: (
    model: Model<Api>,
    context: Context,
    options: ModelsApiStreamOptions<Api>,
  ) => Promise<AssistantMessage>;
}

type PanelAttempt = (
  work: () => Promise<AssistantMessage>,
  signal: AbortSignal,
) => Promise<AssistantMessage>;

export const panelMember = (
  registry: PanelCompletion,
  model: Model<Api>,
  attempt: PanelAttempt = (work) => work(),
): PanelMember => {
  return async (prompt, signal) => {
    try {
      const reply = await attempt(
        () =>
          registry.complete(
            model,
            {
              systemPrompt: prompt.system,
              messages: [{ role: 'user', content: prompt.user, timestamp: Date.now() }],
            },
            { signal },
          ),
        signal,
      );

      if (reply.stopReason !== 'stop') {
        return { kind: 'error' };
      }

      return { kind: 'replied', text: contentText(reply.content).trim() };
    } catch {
      return { kind: 'error' };
    }
  };
};
