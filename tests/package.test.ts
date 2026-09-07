import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxAssistantMessage, registerFauxProvider } from '@mariozechner/pi-ai';
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@mariozechner/pi-coding-agent';
import { expect, it } from 'vitest';

it('loads Tau through Pi with commit features and writing rules on each run', async ({
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
    expect(extensions).toHaveLength(1);
    expect(extensions[0]?.tools.has('commit')).toBe(true);
    expect(extensions[0]?.commands.has('commit')).toBe(true);
    expect(extensions[0]?.handlers.get('tool_call')).toHaveLength(1);
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(['commit']);
    expect(loader.getSkills().diagnostics).toEqual([]);

    const faux = registerFauxProvider({ provider: 'tau-package-writing' });
    onTestFinished(() => {
      faux.unregister();
    });
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(faux.getModel().provider, 'faux-key');
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
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
    expect(prompts[0]?.split(instructions)).toHaveLength(2);
    expect(prompts[0]?.startsWith(basePrompt)).toBe(true);
    expect(prompts[1]).toBe(prompts[0]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
