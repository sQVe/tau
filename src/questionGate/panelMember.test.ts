import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsApiStreamOptions,
} from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { panelMember } from './panelMember.ts';

const prompt = { system: 'Pick one option.', user: '{"question":"Which database?"}' };
const signal = new AbortController().signal;
const model = { provider: 'tau-fixture', id: 'panel-a' } as unknown as Model<Api>;

const registry = (reply: AssistantMessage | Error) => {
  const complete = vi.fn<
    (
      model: Model<Api>,
      context: Context,
      options: ModelsApiStreamOptions<Api>,
    ) => Promise<AssistantMessage>
  >(async () => {
    if (reply instanceof Error) {
      throw reply;
    }

    return reply;
  });

  return { registry: { complete } as unknown as ModelRegistry, complete };
};

it('sends the prompt and signal and trims the reply', async () => {
  const { registry: fake, complete } = registry(fauxAssistantMessage('  Postgres \n'));

  expect(await panelMember(fake, model)(prompt, signal)).toEqual({
    kind: 'replied',
    text: 'Postgres',
  });

  expect(complete).toHaveBeenCalledWith(
    model,
    {
      systemPrompt: prompt.system,
      messages: [{ role: 'user', content: prompt.user, timestamp: expect.any(Number) as unknown }],
    },
    { signal },
  );
});

it('returns error when the reply stops or the call throws', async () => {
  const stopped = registry(fauxAssistantMessage('Postgres', { stopReason: 'error' }));
  const thrown = registry(new Error('offline'));

  expect(await panelMember(stopped.registry, model)(prompt, signal)).toEqual({ kind: 'error' });
  expect(await panelMember(thrown.registry, model)(prompt, signal)).toEqual({ kind: 'error' });
});
