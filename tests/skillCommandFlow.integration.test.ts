import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
  fauxProvider,
} from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

// Real Pi sessions need extra time on slow CI.
vi.setConfig({ testTimeout: 60_000 });

const packageRoot = resolve(import.meta.dirname, '..');

const createSession = async (registerCleanup: TestContext['onTestFinished']) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-skill-command-'));
  const agentDirectory = await mkdtemp(join(tmpdir(), 'tau-skill-command-agent-'));
  registerCleanup(() => rm(directory, { recursive: true, force: true }));
  registerCleanup(() => rm(agentDirectory, { recursive: true, force: true }));

  const faux = fauxProvider({ provider: 'tau-skill-command-test' });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: agentDirectory,
    settingsManager,
    additionalExtensionPaths: [join(packageRoot, 'src/extensions')],
    additionalSkillPaths: [join(packageRoot, 'skills')],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });

  await loader.reload();

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: agentDirectory,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(directory),
    settingsManager,
    tools: ['read'],
  });
  registerCleanup(() => {
    session.dispose();
  });

  await session.bindExtensions({});

  return { session, faux };
};

const lastUserTextOf = (context: { messages: { role: string; content: unknown }[] }) => {
  const user = context.messages.findLast((message) => message.role === 'user');

  if (!Array.isArray(user?.content)) {
    throw new TypeError(`No user message with content blocks: ${JSON.stringify(context.messages)}`);
  }

  return (user.content as { type: string; text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
};

describe('skill commands', () => {
  it.for(['bro', 'commit'])(
    'sends the %s skill body to the model',
    async (skillName, { onTestFinished }) => {
      const { session, faux } = await createSession(onTestFinished);
      const { promise: sentText, resolve: resolveSentText } = Promise.withResolvers<string>();

      faux.setResponses([
        (context) => {
          resolveSentText(lastUserTextOf(context));

          return fauxAssistantMessage('Done.');
        },
      ]);

      await session.prompt(`/${skillName} extra context`);

      const text = await sentText;

      expect(text).toMatch(new RegExp(`^<skill name="${skillName}" `));
      expect(text).toMatch(/<\/skill>\n\nextra context$/);
    },
  );
});
