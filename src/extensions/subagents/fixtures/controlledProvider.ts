import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { readTask } from '../records.js';

// oxlint-disable-next-line node/no-process-env -- The real CLI test binds its fixture through the production task environment.
const directory = process.env.TAU_WORKER_RECORD;
const activeCancellation = directory && readTask(directory).task.includes('active cancellation');
const provider = fauxProvider({
  provider: 'tau-worker-fixture',
  api: 'tau-worker-fixture',
  ...(activeCancellation ? { tokensPerSecond: 100 } : {}),
});
export const fixtureModel = provider.getModel();

export const fixtureAuth = {
  apiKey: {
    name: 'Fixture',
    resolve: () => Promise.resolve({ auth: { apiKey: 'fixture-key-not-a-secret' } }),
  },
};

export default function controlledProvider(pi: ExtensionAPI) {
  if (activeCancellation) {
    provider.setResponses([fauxAssistantMessage('Active streaming fixture. '.repeat(1000))]);
    pi.on('message_update', () => {
      writeFileSync(join(process.cwd(), 'streaming'), 'active');
    });
    pi.registerProvider({ ...provider.provider, auth: fixtureAuth });
    return;
  }
  provider.setResponses([
    fauxAssistantMessage([
      fauxToolCall('edit', {
        path: 'source.txt',
        edits: [{ oldText: 'before', newText: 'after' }],
      }),
    ]),
    fauxAssistantMessage([
      fauxToolCall('bash', { command: 'test "$(cat source.txt)" = after && printf command-ok' }),
      fauxToolCall('bash', { command: 'find ./delete-fixture/.git -delete' }),
    ]),
    (context) => {
      const blocked = context.messages.some(
        (message) =>
          message.role === 'toolResult' &&
          JSON.stringify(message.content).includes('BLOCKED by CC Safety Net'),
      );
      const edited = readFileSync(join(process.cwd(), 'source.txt'), 'utf8') === 'after\n';

      return fauxAssistantMessage([
        fauxToolCall('subagent_report', {
          outcome: blocked && edited ? 'success' : 'failure',
          summary: 'Model-free CLI fixture completed.',
          evidence: ['edit checked', `Safety Net block: ${blocked}`],
        }),
      ]);
    },
  ]);
  pi.registerProvider({ ...provider.provider, auth: fixtureAuth });
}
