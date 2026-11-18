import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, FauxProviderHandle, Model } from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';
import { expect, it, vi } from 'vitest';

import modelFallbackExtension from '../src/extensions/modelFallback/modelFallback.js';
import { createBoundSession } from './piSession.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface HarnessOptions {
  fallback?: string;
  allowedModels?: string[];
}

interface Harness {
  session: AgentSession;
  primary: FauxProviderHandle;
  fallback: FauxProviderHandle;
}

vi.setConfig({ testTimeout: 60_000 });

const overloaded = () =>
  fauxAssistantMessage('', {
    stopReason: 'error',
    errorMessage: '429 Service temporarily overloaded',
  });

const overloadedResponses = () => Array.from({ length: 10 }, () => overloaded);

const textOf = (message: AssistantMessage): string =>
  message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');

const lastAssistant = (session: AgentSession): AssistantMessage => {
  const message = session.messages.findLast((candidate) => candidate.role === 'assistant');

  if (message?.role !== 'assistant') {
    throw new Error('The session has no assistant message.');
  }

  return message;
};

const createHarness = async (
  onTestFinished: TestContext['onTestFinished'],
  options: HarnessOptions = {},
): Promise<Harness> => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-fallback-agent-');
  const directory = temporaryDirectory(onTestFinished, 'tau-fallback-repository-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const primary = fauxProvider({
    provider: 'tau-primary',
    models: [{ id: 'primary-model' }],
  });

  const fallback = fauxProvider({
    provider: 'tau-fallback',
    models: [{ id: 'fallback-model' }],
  });

  const name = 'deepseek-flash';

  const model = {
    primary: 'tau-primary/primary-model',
    fallback: options.fallback ?? 'tau-fallback/fallback-model',
    fallbackAtRetry: 5,
  };

  const tauConfig = {
    fallbackModels: { [name]: model },
    ...(options.allowedModels === undefined ? {} : { allowedModels: options.allowedModels }),
  };

  writeFileSync(join(agentDirectory, 'tau.json'), JSON.stringify(tauConfig));

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory,
    providers: [primary, fallback],
    settings: {
      compaction: { enabled: false },
      retry: { maxRetries: 6, baseDelayMs: 1, maxAgentDelayMs: 1 },
    },
    extensionFactories: [modelFallbackExtension],
  });

  const virtual = session.modelRuntime.getModel('tau', name);

  if (virtual === undefined) {
    throw new Error(`The extension did not register tau/${name}.`);
  }

  // The credential check of a routed model reads the availability snapshot, which Pi fills in the
  // background after registration.
  await session.modelRuntime.refresh({ allowNetwork: false });
  await session.setModel(virtual);

  return { session, primary, fallback };
};

it('answers from the fallback on the fifth retry', async ({ onTestFinished }) => {
  const { session, primary, fallback } = await createHarness(onTestFinished);

  primary.setResponses(overloadedResponses());
  fallback.setResponses([fauxAssistantMessage('fallback ok')]);

  await session.prompt('Start the task.');

  const answer = lastAssistant(session);

  expect(answer.provider).toBe('tau-fallback');
  expect(answer.model).toBe('fallback-model');
  expect(textOf(answer)).toBe('fallback ok');
  expect(primary.state.callCount).toBe(5);
});

it('returns to the primary on the next user message', async ({ onTestFinished }) => {
  const { session, primary, fallback } = await createHarness(onTestFinished);

  primary.setResponses(overloadedResponses());
  fallback.setResponses([fauxAssistantMessage('fallback ok')]);

  await session.prompt('Start the task.');

  primary.setResponses([fauxAssistantMessage('primary ok')]);

  await session.prompt('Continue the task.');

  const answer = lastAssistant(session);

  expect(answer.provider).toBe('tau-primary');
  expect(answer.model).toBe('primary-model');
  expect(textOf(answer)).toBe('primary ok');
});

const directTarget = async (session: AgentSession): Promise<string> => {
  const model: Model<Api> | undefined = session.model;

  if (model === undefined) {
    throw new Error('The session has no model.');
  }

  const route = await session.modelRuntime.resolveModel(model, convertToLlm(session.messages), {
    reason: 'direct',
    thinkingLevel: 'off',
  });

  return `${route.model.provider}/${route.model.id}`;
};

it('routes a direct request after a fallback answer to the fallback', async ({
  onTestFinished,
}) => {
  const { session, primary, fallback } = await createHarness(onTestFinished);

  primary.setResponses(overloadedResponses());
  fallback.setResponses([fauxAssistantMessage('fallback ok')]);

  await session.prompt('Start the task.');

  expect(await directTarget(session)).toBe('tau-fallback/fallback-model');
});

it('routes a direct request after a primary answer to the primary', async ({ onTestFinished }) => {
  const { session, primary } = await createHarness(onTestFinished);

  primary.setResponses([fauxAssistantMessage('primary ok')]);

  await session.prompt('Start the task.');

  expect(await directTarget(session)).toBe('tau-primary/primary-model');
});

it('routes a direct request without an earlier answer to the primary', async ({
  onTestFinished,
}) => {
  const { session } = await createHarness(onTestFinished);

  expect(await directTarget(session)).toBe('tau-primary/primary-model');
});

it('fails a route to an unknown model', async ({ onTestFinished }) => {
  const { session, primary } = await createHarness(onTestFinished, {
    fallback: 'tau-fallback/missing-model',
  });

  primary.setResponses(overloadedResponses());

  await session.prompt('Start the task.');

  const answer = lastAssistant(session);

  expect(answer.stopReason).toBe('error');
  expect(answer.errorMessage).toContain('tau-fallback/missing-model');
});

it('refuses a fallback outside allowedModels', async ({ onTestFinished }) => {
  const { session, primary, fallback } = await createHarness(onTestFinished, {
    allowedModels: ['tau/deepseek-flash', 'tau-primary/primary-model'],
  });

  primary.setResponses(overloadedResponses());

  await session.prompt('Start the task.');

  const answer = lastAssistant(session);

  expect(answer.stopReason).toBe('error');
  expect(answer.errorMessage).toContain('tau-fallback/fallback-model');
  expect(answer.errorMessage).toContain('is not allowed');
  expect(fallback.state.callCount).toBe(0);
});
