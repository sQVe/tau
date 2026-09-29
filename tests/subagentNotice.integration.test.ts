import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai';
import type { AgentSession, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { expect, it, vi } from 'vitest';

import { deliverWorkerNotice } from '../src/extensions/subagents/index.js';
import { appendSystemPrompt } from '../src/systemPrompt/index.js';
import { createBoundSession } from './piSession.js';

vi.setConfig({ testTimeout: 60_000 });

const fixtureNotice = {
  content: { taskId: 'task-1', state: 'stopped', outcome: 'success' },
  details: {},
  question: false,
};

const contextHasNotice = (messages: Message[]): boolean =>
  JSON.stringify(messages).includes('task-1');

const appendedRule = 'Fixture rule appended in before_agent_start.';

const waitForSettle = (session: AgentSession): Promise<undefined> => {
  const settled = Promise.withResolvers<undefined>();

  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'agent_settled') {
      unsubscribe();
      settled.resolve(undefined);
    }
  });

  return settled.promise;
};

const createHarness = async (
  registerCleanup: Parameters<typeof createBoundSession>[0],
  options: { blockTool: boolean },
) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-subagent-notice-'));
  registerCleanup(() => rm(directory, { recursive: true, force: true }));

  const faux = fauxProvider({ provider: 'tau-notice-fixture' });
  const contexts: Context[] = [];
  const startPrompts: string[] = [];
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let capturedPi: ExtensionAPI | undefined;
  let capturedContext: ExtensionContext | undefined;

  const fixtureExtension = (pi: ExtensionAPI) => {
    capturedPi = pi;

    pi.on('session_start', (_event, context) => {
      capturedContext = context;
    });

    pi.on('before_agent_start', (event) => {
      appendSystemPrompt(event, appendedRule);
    });

    // Pi-claude-bridge records this prompt at agent_start and fails a turn it cannot match.
    pi.on('agent_start', (_event, context) => {
      startPrompts.push(context.getSystemPrompt());
    });

    pi.registerTool({
      name: 'subagent_status',
      label: 'subagent_status',
      description: 'Read worker status.',
      parameters: Type.Object({}),
      execute: async () => {
        entered.resolve(undefined);

        if (options.blockTool) {
          await release.promise;
        }

        return { content: [{ type: 'text', text: 'status unchanged' }], details: {} };
      },
    });
  };

  const { session } = await createBoundSession(registerCleanup, {
    cwd: directory,
    agentDirectory: join(directory, 'agent'),
    providers: [faux],
    tools: ['subagent_status'],
    extensionFactories: [fixtureExtension],
  });

  if (!capturedPi || !capturedContext) {
    throw new Error('Fixture extension did not capture the Pi API and context.');
  }

  return {
    session,
    faux,
    contexts,
    startPrompts,
    pi: capturedPi,
    context: capturedContext,
    toolEntered: entered.promise,
    releaseTool: () => {
      release.resolve(undefined);
    },
  };
};

const recordResponse =
  (contexts: Context[], respond: () => AssistantMessage) =>
  (context: Context): AssistantMessage => {
    contexts.push(context);

    return respond();
  };

it('wakes an idle manager and includes the notice in its first provider request', async ({
  onTestFinished,
}) => {
  const harness = await createHarness(onTestFinished, { blockTool: false });

  harness.faux.setResponses([
    recordResponse(harness.contexts, () => fauxAssistantMessage('Done.')),
  ]);

  const settled = waitForSettle(harness.session);

  deliverWorkerNotice(harness.pi, harness.context, fixtureNotice);
  await settled;

  expect(harness.contexts).toHaveLength(1);
  expect(contextHasNotice(harness.contexts[0]?.messages ?? [])).toBe(true);
});

it('keeps before_agent_start prompt additions on the turn an idle notice starts', async ({
  onTestFinished,
}) => {
  const harness = await createHarness(onTestFinished, { blockTool: false });

  harness.faux.setResponses([
    recordResponse(harness.contexts, () => fauxAssistantMessage('Ready.')),
    recordResponse(harness.contexts, () => fauxAssistantMessage('Notice handled.')),
  ]);

  await harness.session.prompt('Begin.');
  const settled = waitForSettle(harness.session);

  deliverWorkerNotice(harness.pi, harness.context, fixtureNotice);
  await settled;

  const notified = harness.contexts[1]?.messages ?? [];

  expect(harness.contexts).toHaveLength(2);
  expect(contextHasNotice(notified)).toBe(true);
  expect(harness.startPrompts).toHaveLength(2);
  expect(harness.startPrompts[1]).toContain(appendedRule);
  expect(getCurrentSystemPrompt(notified)).toContain(appendedRule);
  // The addition stays in the first system message instead of being removed and sent again.
  expect(JSON.stringify(notified).split(appendedRule)).toHaveLength(2);
});

it('delivers an active manager notice at the steering point before the final answer', async ({
  onTestFinished,
}) => {
  const harness = await createHarness(onTestFinished, { blockTool: true });

  harness.faux.setResponses([
    recordResponse(harness.contexts, () =>
      fauxAssistantMessage([fauxToolCall('subagent_status', {})]),
    ),
    recordResponse(harness.contexts, () => fauxAssistantMessage('Final answer.')),
    recordResponse(harness.contexts, () => fauxAssistantMessage('Notice handled.')),
  ]);

  const settled = waitForSettle(harness.session);
  const running = harness.session.prompt('Begin.');

  await harness.toolEntered;
  deliverWorkerNotice(harness.pi, harness.context, fixtureNotice);
  harness.releaseTool();
  await running;
  await settled;

  expect(harness.contexts).toHaveLength(2);
  expect(contextHasNotice(harness.contexts[0]?.messages ?? [])).toBe(false);
  expect(contextHasNotice(harness.contexts[1]?.messages ?? [])).toBe(true);
  expect(harness.faux.getPendingResponseCount()).toBe(1);
});
