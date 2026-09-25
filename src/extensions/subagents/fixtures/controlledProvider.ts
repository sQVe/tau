import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { readTask } from '../records.js';

const directory = process.env.TAU_WORKER_RECORD;
const savedTask = directory != null && directory !== '' ? readTask(directory) : undefined;
const activeCancellation = savedTask?.task.includes('active cancellation') === true;
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

const registerFollowUpProvider = (pi: ExtensionAPI): void => {
  provider.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'find ./delete-fixture/.git -delete' })]),
    (context) => {
      const prior = context.messages.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes(savedTask?.predecessorTaskId ?? 'missing'),
      );
      const blocked = JSON.stringify(
        context.messages.findLast(
          (message) => message.role === 'toolResult' && message.toolName === 'bash',
        ),
      ).includes('BLOCKED by CC Safety Net');
      const instructions = JSON.stringify(
        context.messages.findLast((message) => message.role === 'user'),
      ).includes(savedTask?.loadout.instructions ?? '');

      return fauxAssistantMessage([
        fauxToolCall('subagent_report', {
          outcome: prior && blocked && instructions ? 'success' : 'failure',
          summary: 'Native follow-up checked.',
          evidence: [
            `prior context: ${prior}`,
            `Safety Net block: ${blocked}`,
            `saved instructions: ${instructions}`,
          ],
        }),
      ]);
    },
  ]);
  pi.registerProvider({ ...provider.provider, auth: fixtureAuth });
};

const registerCancellationProvider = (pi: ExtensionAPI): void => {
  provider.setResponses([fauxAssistantMessage('Active streaming fixture. '.repeat(1000))]);
  pi.on('message_update', () => {
    writeFileSync(join(process.cwd(), 'streaming'), 'active');
  });
  pi.registerProvider({ ...provider.provider, auth: fixtureAuth });
};

const registerDefaultProvider = (pi: ExtensionAPI): void => {
  const asking =
    directory != null && directory !== '' ? readTask(directory).task.includes('question') : false;

  const responses: Parameters<typeof provider.setResponses>[0] = [];

  if (asking) {
    responses.push(
      fauxAssistantMessage([
        fauxToolCall('subagent_question', {
          question: 'May I edit source.txt within the assigned scope?',
        }),
      ]),
    );
  }

  responses.push(
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
  );
  provider.setResponses(responses);
  pi.registerProvider({ ...provider.provider, auth: fixtureAuth });
};

export default function controlledProvider(pi: ExtensionAPI) {
  if (savedTask?.predecessorTaskId != null) {
    registerFollowUpProvider(pi);

    return;
  }

  if (activeCancellation) {
    registerCancellationProvider(pi);

    return;
  }

  registerDefaultProvider(pi);
}
