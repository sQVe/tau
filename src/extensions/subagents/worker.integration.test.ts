import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi, onTestFinished } from 'vitest';

import { modelFingerprint, providerFingerprint, integrationFingerprint } from './loadout.js';
import { nativeIdentity, seedSession } from './profiles.js';
import { publish, readEvent, readReport, validateTask } from './records.js';
import workerExtension from './worker.js';

it.each(['editing', 'investigation'] as const)(
  'runs real Pi %s with Safety Net and durable handover',
  async (role) => {
    const safety = join(
      dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
      'dist',
      'pi',
      'index.js',
    );
    const expectedSource = role === 'editing' ? 'after' : 'before';
    const directory = mkdtempSync(join(tmpdir(), 'tau-worker-pi-'));
    onTestFinished(() => {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    });
    vi.stubEnv('PI_CODING_AGENT_DIR', directory);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const provider = fauxProvider({ provider: 'tau-worker-fixture' });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(provider.provider);
    const model = provider.getModel();
    const taskDirectory = join(directory, 'task');
    mkdirSync(taskDirectory);
    vi.stubEnv('TAU_WORKER_RECORD', taskDirectory);
    const task = validateTask({
      version: 1,
      taskId: 'fixture-task',
      task: 'Edit source.txt and check it.',
      parentSession: join(directory, 'parent.jsonl'),
      parentSessionId: 'parent',
      ownerId: 'owner',
      ...nativeIdentity(taskDirectory),
      createdAt: Date.now(),
      deadline: Date.now() + 30_000,
      cancellationBudget: 2000,
      loadout: {
        profile: 'worker',
        role,
        model: `${model.provider}/${model.id}`,
        modelFingerprint: modelFingerprint(model),
        providerFingerprint: await providerFingerprint(new ModelRegistry(runtime), model),
        thinking: 'off',
        cwd: directory,
        agentDirectory: directory,
        permissions: 'trusted-full-tools',
        tools: ['read', 'bash', 'edit', 'write', 'subagent_report'],
        integrations: [safety],
        integrationFingerprint: integrationFingerprint([safety]),
        safetyExtension: safety,
        instructions: 'Edit the fixture only.',
      },
    });
    publish(taskDirectory, 'task.json', task);
    seedSession(task);
    writeFileSync(join(directory, 'source.txt'), 'before\n');
    mkdirSync(join(directory, 'delete-fixture', '.git'), { recursive: true });
    writeFileSync(join(directory, 'delete-fixture', '.git', 'keep'), 'preserve');
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: [safety],
      extensionFactories: [workerExtension],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      model,
      thinkingLevel: 'off',
      sessionManager: SessionManager.open(task.nativeSessionFile),
      settingsManager,
      resourceLoader: loader,
    });
    onTestFinished(() => {
      session.dispose();
    });
    const results: { toolName: string; isError: boolean; text: string }[] = [];
    const finished = Promise.withResolvers<undefined>();
    session.subscribe((event) => {
      if (event.type === 'tool_execution_end') {
        results.push({
          toolName: event.toolName,
          isError: event.isError,
          text: JSON.stringify(event.result),
        });
      }
      if (event.type === 'agent_settled') {
        finished.resolve(undefined);
      }
    });
    provider.setResponses([
      fauxAssistantMessage([
        fauxToolCall('subagent_report', {
          outcome: 'success',
          summary: 'Premature mixed-batch report.',
          evidence: [],
        }),
        fauxToolCall('read', { path: 'source.txt' }),
        role === 'editing'
          ? fauxToolCall('edit', {
              path: 'source.txt',
              edits: [{ oldText: 'before', newText: 'after' }],
            })
          : fauxToolCall('read', { path: 'source.txt' }),
      ]),
      fauxAssistantMessage([
        fauxToolCall('bash', {
          command: `test "$(cat source.txt)" = ${expectedSource} && printf command-ok`,
        }),
        fauxToolCall('bash', { command: 'find ./delete-fixture/.git -delete' }),
      ]),
      fauxAssistantMessage([
        fauxToolCall('subagent_report', {
          outcome: 'success',
          summary: 'Edited and checked the fixture.',
          evidence: ['source.txt', 'command-ok', 'Safety Net blocked deletion'],
        }),
      ]),
    ]);
    await session.bindExtensions({});
    publish(taskDirectory, 'dispatch.json', { taskId: task.taskId });
    await finished.promise;

    expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe(`${expectedSource}\n`);
    expect(results.find((result) => result.text.includes('command-ok'))?.isError).toBe(false);
    expect(
      results.find((result) => result.text.includes('BLOCKED by CC Safety Net'))?.isError,
    ).toBe(true);
    expect(readFileSync(join(directory, 'delete-fixture', '.git', 'keep'), 'utf8')).toBe(
      'preserve',
    );
    expect(
      results.some(
        (result) =>
          result.toolName === 'subagent_report' && result.isError && result.text.includes('alone'),
      ),
    ).toBe(true);
    expect(readReport(taskDirectory, task.taskId)?.summary).toBe('Edited and checked the fixture.');
    expect(readEvent(taskDirectory, task.taskId, 'accepted')).toBeDefined();
    expect(readEvent(taskDirectory, task.taskId, 'settled')?.stopped).toBe(true);
    const original = readFileSync(join(taskDirectory, 'report.json'), 'utf8');
    await session.bindExtensions({});
    expect(readEvent(taskDirectory, task.taskId, 'continuationRefused')?.detail).toContain(
      'continuation',
    );
    expect(readFileSync(join(taskDirectory, 'report.json'), 'utf8')).toBe(original);
  },
  10_000,
);
