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

it('loads Tau through Pi with commit features, the bundled question tool, and writing rules on each run', async ({
  onTestFinished,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-package-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));

  try {
    const agentDir = join(cwd, 'agent');
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
    expect(extensions).toHaveLength(2);
    const tauExtension = extensions.find((extension) => extension.tools.has('commit'));
    expect(tauExtension?.commands.has('commit')).toBe(true);
    expect(tauExtension?.handlers.get('tool_call')).toHaveLength(1);
    expect(extensions.some((extension) => extension.tools.has('ask_user_question'))).toBe(true);
    expect(
      loader
        .getSkills()
        .skills.map((skill) => skill.name)
        .toSorted(),
    ).toEqual(['bro', 'commit']);
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
    expect(instructions).toContain('Write for readers who use English as a second language.');
    expect(prompts[0]?.startsWith(basePrompt)).toBe(true);
    for (const prompt of prompts) {
      expect(prompt.split(instructions)).toHaveLength(2);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
