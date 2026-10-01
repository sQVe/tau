import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
  fauxProvider,
  getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  parseFrontmatter,
} from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  NormalizedBuildSystemPromptOptions,
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import manifest from '../package.json' with { type: 'json' };
import { bulkReadGuidelines } from '../src/extensions/bulkRead/bulkRead.js';
import { commitToolGuidelines } from '../src/extensions/commit/tool.js';
import { delegationGuidelines } from '../src/extensions/subagents/subagents.js';
import { readInstructionSet } from '../src/instructionSets.js';
import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';

it('ships Safety Net as a runtime dependency and explicit extension', () => {
  expect(manifest.dependencies).toHaveProperty('cc-safety-net', '2.4.1');
  expect(manifest.devDependencies).not.toHaveProperty('cc-safety-net');
  expect(manifest.pi.extensions).toContain('./node_modules/cc-safety-net/dist/pi/index.js');
});

it('loads Tau through Pi with commit features, question and bundled web tools, and writing and coding rules but not browser rules on every run', async ({
  onTestFinished,
}) => {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'tau-package-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));

  try {
    const agentDirectory = join(workingDirectory, 'agent');
    isolateWebAccessConfig(agentDirectory, onTestFinished);

    // Delegation guidelines load only for a manager inside herdr.
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    vi.stubEnv('HERDR_ENV', '1');
    vi.stubEnv('HERDR_PANE_ID', 'parent');
    vi.stubEnv('HERDR_SOCKET_PATH', join(workingDirectory, 'herdr.sock'));

    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });

    // Pi-claude-bridge keeps this options object at before_agent_start and forwards only its
    // appendSystemPrompt and context files at agent_start, after every handler has run.
    const forwarded: NormalizedBuildSystemPromptOptions[] = [];

    const bridge = (pi: ExtensionAPI) => {
      let options: NormalizedBuildSystemPromptOptions | undefined;

      pi.on('before_agent_start', (event) => {
        options = event.systemPromptOptions;
      });

      pi.on('agent_start', () => {
        if (options) {
          forwarded.push(structuredClone(options));
        }
      });
    };

    const loader = new DefaultResourceLoader({
      cwd: workingDirectory,
      agentDir: agentDirectory,
      settingsManager,
      additionalExtensionPaths: [packageRoot],
      extensionFactories: [bridge],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });

    await loader.reload();

    const { extensions, errors } = loader.getExtensions();

    expect(errors).toEqual([]);
    expect(extensions).toHaveLength(4);
    const safetyExtension = extensions.find((extension) => extension.commands.has('cc-safety-net'));
    expect(safetyExtension).toBeDefined();
    expect(safetyExtension?.handlers.has('tool_call')).toBe(true);

    const tauExtension = extensions.find((extension) => extension.tools.has('commit'));

    expect(tauExtension?.tools.has('bulk_read')).toBe(true);
    expect(tauExtension?.tools.has('run_tests')).toBe(true);
    expect(extensions.some((extension) => extension.tools.has('ask_user_question'))).toBe(true);

    const webAccessExtension = extensions.find((extension) => extension.tools.has('web_search'));

    expect(webAccessExtension).toBeDefined();

    expect([...(webAccessExtension?.tools.keys() ?? [])].toSorted()).toEqual([
      'fetch_content',
      'get_search_content',
      'source_check',
      'web_enable',
      'web_search',
    ]);

    expect(
      loader
        .getSkills()
        .skills.map((skill) => skill.name)
        .toSorted(),
    ).toEqual([
      'bro',
      'code-review',
      'commit',
      'diagram',
      'handoff',
      'pr',
      'pr-feedback',
      'slice',
      'stack',
      'start-slice',
      'tdd',
      'triage-findings',
      'update-branch',
      'worktree',
    ]);

    expect(loader.getSkills().diagnostics).toEqual([]);

    const skillsWithoutCommand = loader
      .getSkills()
      .skills.filter((skill) => tauExtension?.commands.has(skill.name) !== true);

    expect(skillsWithoutCommand).toEqual([]);

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
      tools: ['subagent', 'bulk_read', 'commit'],
    });

    onTestFinished(() => {
      session.dispose();
    });

    await session.bindExtensions({});

    const prompts: string[] = [];
    const transcripts: string[] = [];

    scriptedProvider.setResponses(
      [0, 1].map(() => (context) => {
        prompts.push(getCurrentSystemPrompt(context.messages));
        transcripts.push(JSON.stringify(context.messages));

        return fauxAssistantMessage('Ready.');
      }),
    );

    await session.prompt('First run.');
    await session.prompt('Second run.');

    expect(prompts).toHaveLength(2);

    const writingInstructions = await readFile(
      join(packageRoot, 'src/instructions/writing.md'),
      'utf8',
    );

    const codingInstructions = await readFile(
      join(packageRoot, 'src/instructions/coding.md'),
      'utf8',
    );

    const workflowInstructions = await readFile(
      join(packageRoot, 'src/instructions/workflow.md'),
      'utf8',
    );

    expect(writingInstructions).toContain(
      'Write for readers who use English as a second language.',
    );

    expect(codingInstructions).toContain('Separate the logical steps in every function');

    expect(codingInstructions).not.toContain('bulk_read');

    const prSkill = await readFile(join(packageRoot, 'src/skills/pr/SKILL.md'), 'utf8');

    const { metadata } = parseFrontmatter<{ metadata?: Record<string, unknown> }>(
      prSkill,
    ).frontmatter;

    const prRequiredFor = metadata?.['required-for'];

    expect(prRequiredFor).toEqual(expect.any(String));

    const blocks = [
      writingInstructions.trim(),
      codingInstructions.trim(),
      workflowInstructions.trim(),
      String(prRequiredFor),
      ...delegationGuidelines(undefined),
      ...bulkReadGuidelines,
      ...commitToolGuidelines,
    ];

    expect(forwarded).toHaveLength(2);

    for (const options of forwarded) {
      expect(options.forceSystemPrompt).toBeUndefined();

      for (const block of blocks) {
        expect(options.appendSystemPrompt.split(block)).toHaveLength(2);
      }
    }

    for (const prompt of prompts) {
      for (const block of blocks) {
        expect(prompt.split(block)).toHaveLength(2);
      }
    }

    for (const block of blocks) {
      expect(transcripts[1]?.split(JSON.stringify(block).slice(1, -1))).toHaveLength(2);
    }

    const browserInstructions = await readInstructionSet('browser');

    for (const prompt of prompts) {
      expect(prompt).not.toContain(browserInstructions);
    }
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}, 30_000);

it('reports an extension error for a missing bundled web extension', async ({ onTestFinished }) => {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'tau-package-missing-'));
  onTestFinished(() => rm(workingDirectory, { recursive: true, force: true }));

  const agentDirectory = join(workingDirectory, 'agent');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });

  const loader = new DefaultResourceLoader({
    cwd: workingDirectory,
    agentDir: agentDirectory,
    settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL('../src/tau.ts', import.meta.url))],
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

  expect(errors).toHaveLength(1);

  const webAccessError = errors.find((error) => error.includes('pi-web-access'));

  expect(webAccessError).toContain('web_search');
  expect(webAccessError).toContain('fetch_content');
}, 30_000);

it('loads Tau as a Pi package without extension warnings', async ({ onTestFinished }) => {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'tau-package-warnings-'));
  onTestFinished(() => rm(workingDirectory, { recursive: true, force: true }));

  const agentDirectory = join(workingDirectory, 'agent');
  isolateWebAccessConfig(agentDirectory, onTestFinished);

  const loader = new DefaultResourceLoader({
    cwd: workingDirectory,
    agentDir: agentDirectory,
    settingsManager: SettingsManager.inMemory({
      packages: [fileURLToPath(new URL('../', import.meta.url))],
    }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });

  await loader.reload();

  const { errors, warnings } = loader.getExtensions();

  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
}, 30_000);
