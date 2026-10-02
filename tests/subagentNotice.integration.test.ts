import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai';
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { expect, it, vi } from 'vitest';

import { createNoticeDelivery } from '../src/extensions/subagents/index.js';
import { appendSystemPrompt } from '../src/systemPrompt/index.js';
import { createBoundSession } from './piSession.js';

type BeforeCompact = (
  event: SessionBeforeCompactEvent,
  deliverNotice: () => void,
) => Promise<SessionBeforeCompactResult | undefined>;

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
  options: {
    blockTool: boolean;
    beforeCompact?: BeforeCompact;
    // Runs in an agent_start handler that Pi calls before Tau's.
    earlierRunStart?: () => Promise<void>;
  },
) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-subagent-notice-'));
  registerCleanup(() => rm(directory, { recursive: true, force: true }));

  const faux = fauxProvider({ provider: 'tau-notice-fixture' });
  const contexts: Context[] = [];
  const startPrompts: string[] = [];
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let capturedContext: ExtensionContext | undefined;

  let deliver: ReturnType<typeof createNoticeDelivery> | undefined;

  const fixtureExtension = (pi: ExtensionAPI) => {
    pi.on('agent_start', async () => options.earlierRunStart?.());
    deliver = createNoticeDelivery(pi);

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

    pi.on('session_before_compact', async (event) =>
      options.beforeCompact?.(event, () => deliver?.(capturedContext, fixtureNotice)),
    );

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
    // A small kept tail leaves the first exchange to summarize.
    settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
  });

  if (!capturedContext || !deliver) {
    throw new Error('Fixture extension did not capture its context and notice delivery.');
  }

  return {
    session,
    faux,
    contexts,
    startPrompts,
    context: capturedContext,
    deliverNotice: (notice = fixtureNotice) => deliver?.(capturedContext, notice),
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

  harness.deliverNotice();
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

  harness.deliverNotice();
  await settled;

  const notified = harness.contexts[1]?.messages ?? [];

  expect(harness.contexts).toHaveLength(2);
  expect(contextHasNotice(notified)).toBe(true);
  expect(harness.startPrompts).toHaveLength(2);
  expect(harness.startPrompts[1]).toContain(appendedRule);
  expect(getCurrentSystemPrompt(notified)).toContain(appendedRule);
  expect(JSON.stringify(notified).split(appendedRule)).toHaveLength(2);
});

it('starts one turn for idle notices that arrive before it runs', async ({ onTestFinished }) => {
  const harness = await createHarness(onTestFinished, { blockTool: false });
  const idleDuringRequest: boolean[] = [];

  harness.faux.setResponses([
    recordResponse(harness.contexts, () => {
      idleDuringRequest.push(harness.context.isIdle());

      return fauxAssistantMessage('Both handled.');
    }),
  ]);

  const settled = waitForSettle(harness.session);

  harness.deliverNotice();

  harness.deliverNotice({
    ...fixtureNotice,
    content: { ...fixtureNotice.content, taskId: 'task-2' },
  });

  await settled;

  const messages = JSON.stringify(harness.contexts[0]?.messages ?? []);

  expect(harness.contexts).toHaveLength(1);
  expect(messages).toContain('task-1');
  expect(messages).toContain('task-2');
  expect(idleDuringRequest).toEqual([false]);
  expect(harness.startPrompts[0]).toContain(appendedRule);
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
  harness.deliverNotice();
  harness.releaseTool();
  await running;
  await settled;

  expect(harness.contexts).toHaveLength(2);
  expect(contextHasNotice(harness.contexts[0]?.messages ?? [])).toBe(false);
  expect(contextHasNotice(harness.contexts[1]?.messages ?? [])).toBe(true);
  expect(harness.faux.getPendingResponseCount()).toBe(1);
});

it('sends no request for a notice during a manual compaction and adds it to the next prompt', async ({
  onTestFinished,
}) => {
  const compactingDuringRequest: boolean[] = [];

  const harness = await createHarness(onTestFinished, {
    blockTool: false,
    // Another extension writes the summary here, as pi-claude-bridge does.
    beforeCompact: async (event, deliverNotice) => {
      deliverNotice();
      // Gives a notice turn started too early time to reach the provider.
      await delay(50);

      return {
        compaction: {
          summary: 'Fixture summary.',
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    },
  });

  const respond = (text: string) =>
    recordResponse(harness.contexts, () => {
      compactingDuringRequest.push(harness.session.isCompacting);

      return fauxAssistantMessage(text);
    });

  harness.faux.setResponses([respond('Ready.'), respond('Both handled.')]);

  await harness.session.prompt('Begin.');
  await harness.session.compact();
  // Gives a notice turn started after the compaction time to reach the provider.
  await delay(50);

  expect(harness.contexts).toHaveLength(1);

  await harness.session.prompt('Continue user work.');

  const messages = JSON.stringify(harness.contexts[1]?.messages ?? []);

  expect(harness.contexts).toHaveLength(2);
  expect(compactingDuringRequest).toEqual([false, false]);
  expect(messages).toContain('Continue user work.');
  expect(messages).toContain('task-1');
  expect(messages).toContain('Fixture summary.');
});

it('delivers a notice within a run that started before Tau saw agent_start', async ({
  onTestFinished,
}) => {
  const runStarted = Promise.withResolvers<undefined>();
  const releaseRunStart = Promise.withResolvers<undefined>();
  let paused = false;

  const harness = await createHarness(onTestFinished, {
    blockTool: false,
    earlierRunStart: async () => {
      if (paused) {
        return;
      }

      paused = true;
      runStarted.resolve(undefined);
      await releaseRunStart.promise;
    },
  });

  harness.faux.setResponses([
    recordResponse(harness.contexts, () => fauxAssistantMessage('User work handled.')),
    recordResponse(harness.contexts, () => fauxAssistantMessage('Notice handled.')),
  ]);

  const running = harness.session.prompt('Continue user work.');

  await runStarted.promise;
  harness.deliverNotice();
  releaseRunStart.resolve(undefined);
  await running;
  await harness.session.waitForIdle();

  expect(contextHasNotice(harness.contexts.flatMap((context) => context.messages))).toBe(true);
});
