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

import { WEB_ACCESS_TOOLS } from '../src/extensions/webAccess/index.js';
import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';

it('loads Tau through Pi with commit features, the bundled question and web tools, and writing and coding rules on each run', async ({
  onTestFinished,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-package-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));

  try {
    const agentDir = join(cwd, 'agent');
    isolateWebAccessConfig(agentDir, onTestFinished);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
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
    expect(tauExtension?.handlers.get('tool_call')).toHaveLength(2);
    expect(tauExtension?.handlers.get('session_start')).toHaveLength(4);
    expect(tauExtension?.handlers.get('tool_result')).toHaveLength(1);
    expect(tauExtension?.handlers.get('session_before_switch')).toHaveLength(1);
    expect(tauExtension?.handlers.get('session_before_fork')).toHaveLength(1);
    expect(extensions.some((extension) => extension.tools.has('ask_user_question'))).toBe(true);
    // The TDD guard blocks any tool it does not know, so WEB_ACCESS_TOOLS has to list every
    // tool the bundled package registers. Compare the whole set: an upgrade that adds a tool
    // fails here rather than silently registering one the guard blocks.
    const webAccessExtension = extensions.find((extension) => extension.tools.has('web_search'));
    expect(webAccessExtension).toBeDefined();
    expect([...(webAccessExtension?.tools.keys() ?? [])].toSorted()).toEqual(
      [...WEB_ACCESS_TOOLS].toSorted(),
    );
    expect(
      loader
        .getSkills()
        .skills.map((skill) => skill.name)
        .toSorted(),
    ).toEqual(['bro', 'commit', 'tdd']);
    expect(loader.getSkills().diagnostics).toEqual([]);

    const faux = fauxProvider({ provider: 'tau-package-writing' });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: faux.getModel(),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      tools: [],
    });
    onTestFinished(() => {
      session.dispose();
    });
    await session.bindExtensions({});
    const basePrompt = session.systemPrompt;
    const prompts: string[] = [];
    faux.setResponses(
      [0, 1].map(() => (context) => {
        prompts.push(context.systemPrompt ?? '');
        return fauxAssistantMessage('Ready.');
      }),
    );

    await session.prompt('First run.');
    await session.prompt('Second run.');

    expect(prompts).toHaveLength(2);
    const instructions = await readFile(
      join(packageRoot, 'src/extensions/writing/instructions.md'),
      'utf8',
    );
    const codingInstructions = await readFile(
      join(packageRoot, 'src/extensions/coding/instructions.md'),
      'utf8',
    );
    expect(instructions).toContain('Write for readers who use English as a second language.');
    expect(codingInstructions).toContain(
      'Separate the logical steps inside a function with a blank line.',
    );
    expect(prompts[0]?.startsWith(basePrompt)).toBe(true);
    for (const prompt of prompts) {
      expect(prompt.split(instructions)).toHaveLength(2);
      expect(prompt.split(codingInstructions)).toHaveLength(2);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('reports an extension error for each bundled package that is not loaded', async ({
  onTestFinished,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-package-missing-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, 'agent');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL('../src/extensions', import.meta.url))],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();

  const faux = fauxProvider({ provider: 'tau-package-missing' });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
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
  expect(questionError).toContain('@juicesharp/rpiv-ask-user-question');
  const webAccessError = errors.find((error) => error.includes('pi-web-access'));
  expect(webAccessError).toContain('web_search');
  expect(webAccessError).toContain('fetch_content');
});
