import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

beforeEach(() => {
  // eslint-disable-next-line node/no-process-env -- ADR 0013 defines the delegate environment setting.
  process.env.TAU_BULK_READ_MODEL = 'tau-delegate/reader';
});
afterEach(() => {
  // eslint-disable-next-line node/no-process-env -- ADR 0013 defines the delegate environment setting.
  delete process.env.TAU_BULK_READ_MODEL;
});

const createHarness = async (registerCleanup: TestContext['onTestFinished']) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-bulk-flow-'));
  registerCleanup(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, 'agent');
  const content = Array.from({ length: 450 }, (_, index) => `line ${index + 1}`).join('\n');
  await writeFile(join(cwd, 'large.txt'), content);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [resolve(import.meta.dirname, '../src/extensions/bulkRead/index.ts')],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();

  const sessionModel = fauxProvider({ provider: 'tau-test' });
  const delegate = fauxProvider({ provider: 'tau-delegate', models: [{ id: 'reader' }] });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(sessionModel.provider);
  modelRuntime.registerNativeProvider(delegate.provider);

  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: sessionModel.getModel(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    tools: ['read', 'bulk_read'],
  });
  registerCleanup(() => {
    session.dispose();
  });
  expect(extensionsResult.errors).toEqual([]);
  await session.bindExtensions({});

  return { session, sessionModel, delegate, content };
};

const toolResult = (session: AgentSession, name: string) => {
  const entry = session.sessionManager
    .getEntries()
    .find(
      (candidate) =>
        candidate.type === 'message' &&
        candidate.message.role === 'toolResult' &&
        candidate.message.toolName === name,
    );
  if (entry?.type !== 'message' || entry.message.role !== 'toolResult') {
    throw new Error(`Missing result for ${name}`);
  }

  return entry.message;
};

const textOf = (content: { type: string; text?: string }[]) =>
  content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');

it('clamps a real Pi read and records delegate usage in the session ledger', async ({
  onTestFinished,
}) => {
  const { session, sessionModel, delegate } = await createHarness(onTestFinished);
  sessionModel.setResponses([
    fauxAssistantMessage([fauxToolCall('read', { path: 'large.txt' })]),
    fauxAssistantMessage([
      fauxToolCall('bulk_read', { paths: ['large.txt'], question: 'What does this file contain?' }),
    ]),
    fauxAssistantMessage('Done.'),
  ]);
  delegate.setResponses([fauxAssistantMessage('- large.txt:450 ends with line 450.')]);

  await session.prompt('Explain the large file.');

  const read = textOf(toolResult(session, 'read').content);
  expect(read).toMatch(
    /File continues at line 401\. For a question about this file call bulk_read with paths and question\. To edit, read again with offset and limit\.$/,
  );
  expect(read).not.toContain('Use offset=');
  expect(read).not.toMatch(/^line 401$/m);
  const bulk = toolResult(session, 'bulk_read');
  expect(bulk.usage?.input).toBeGreaterThan(0);
  expect(textOf(bulk.content)).toBe('- large.txt:450 ends with line 450.');
  expect(delegate.state.callCount).toBe(1);
  expect(sessionModel.state.callCount).toBe(3);
});
