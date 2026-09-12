import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { expect, it } from 'vitest';

import { webAccessTools } from '../src/extensions/webAccess/index.js';
import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';

it('loads Tau through Pi with commit features, bundled question and web tools, and writing and coding rules on every run', async ({
  onTestFinished,
}) => {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'tau-package-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));

  try {
    const agentDirectory = join(workingDirectory, 'agent');
    isolateWebAccessConfig(agentDirectory, onTestFinished);

    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: workingDirectory,
      agentDir: agentDirectory,
      settingsManager,
      additionalExtensionPaths: [packageRoot],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();

    const { extensions, errors } = loader.getExtensions();

    expect(errors).toEqual([]);
    expect(extensions).toHaveLength(3);

    const tauExtension = extensions.find((extension) => extension.tools.has('commit'));

    expect(tauExtension?.commands.has('commit')).toBe(true);
    expect(tauExtension?.tools.has('bulk_read')).toBe(true);
    expect(tauExtension?.handlers.get('tool_call')).toHaveLength(4);
    expect(tauExtension?.handlers.get('session_start')).toHaveLength(5);
    expect(tauExtension?.handlers.get('tool_result')).toHaveLength(2);
    expect(tauExtension?.handlers.get('session_before_switch')).toHaveLength(2);
    expect(tauExtension?.handlers.get('session_before_fork')).toHaveLength(2);
    expect(extensions.some((extension) => extension.tools.has('ask_user_question'))).toBe(true);

    // Catch upgrades that add a web tool the TDD guard would block.
    const webAccessExtension = extensions.find((extension) => extension.tools.has('web_search'));

    expect(webAccessExtension).toBeDefined();
    expect([...(webAccessExtension?.tools.keys() ?? [])].toSorted()).toEqual(
      [...webAccessTools].toSorted(),
    );
    expect(
      loader
        .getSkills()
        .skills.map((skill) => skill.name)
        .toSorted(),
    ).toEqual(['bro', 'commit', 'tdd']);
    expect(loader.getSkills().diagnostics).toEqual([]);

    const scriptedProvider = fauxProvider({ provider: 'tau-package-writing' });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(scriptedProvider.provider);

    const { session } = await createAgentSession({
      cwd: workingDirectory,
      agentDir: agentDirectory,
      modelRuntime,
      model: scriptedProvider.getModel(),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(workingDirectory),
      settingsManager,
      tools: [],
    });
    onTestFinished(() => {
      session.dispose();
    });
    await session.bindExtensions({});

    const basePrompt = session.systemPrompt;
    const prompts: string[] = [];
    scriptedProvider.setResponses(
      [0, 1].map(() => (context) => {
        prompts.push(context.systemPrompt ?? '');

        return fauxAssistantMessage('Ready.');
      }),
    );

    await session.prompt('First run.');
    await session.prompt('Second run.');

    expect(prompts).toHaveLength(2);

    const writingInstructions = await readFile(
      join(packageRoot, 'src/extensions/writing/instructions.md'),
      'utf8',
    );
    const codingInstructions = await readFile(
      join(packageRoot, 'src/extensions/coding/instructions.md'),
      'utf8',
    );

    expect(writingInstructions).toContain(
      'Write for readers who use English as a second language.',
    );
    expect(codingInstructions).toContain(
      'Separate the logical steps inside a function with a blank line.',
    );
    expect(codingInstructions).not.toContain('bulk_read');
    expect(prompts[0]?.startsWith(basePrompt)).toBe(true);

    for (const prompt of prompts) {
      expect(prompt.split(writingInstructions)).toHaveLength(2);
      expect(prompt.split(codingInstructions)).toHaveLength(2);
    }
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
});

it('reports an extension error for each bundled package that is not loaded', async ({
  onTestFinished,
}) => {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'tau-package-missing-'));
  onTestFinished(() => rm(workingDirectory, { recursive: true, force: true }));

  const agentDirectory = join(workingDirectory, 'agent');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: workingDirectory,
    agentDir: agentDirectory,
    settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL('../src/extensions', import.meta.url))],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();

  const scriptedProvider = fauxProvider({ provider: 'tau-package-missing' });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(scriptedProvider.provider);

  const { session } = await createAgentSession({
    cwd: workingDirectory,
    agentDir: agentDirectory,
    modelRuntime,
    model: scriptedProvider.getModel(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(workingDirectory),
    settingsManager,
    tools: [],
  });
  onTestFinished(() => {
    session.dispose();
  });

  const errors: string[] = [];
  await session.bindExtensions({
    onError: (error) => {
      errors.push(error.error);
    },
  });

  expect(errors).toHaveLength(2);

  const questionError = errors.find((error) => error.includes('ask_user_question'));
  const webAccessError = errors.find((error) => error.includes('pi-web-access'));

  expect(questionError).toContain('@juicesharp/rpiv-ask-user-question');
  expect(webAccessError).toContain('web_search');
  expect(webAccessError).toContain('fetch_content');
});
