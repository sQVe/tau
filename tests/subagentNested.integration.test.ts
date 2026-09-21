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
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createEventBus,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { monotonicNow, reserveTask } from '../src/extensions/subagents/admission.js';
import * as cancellation from '../src/extensions/subagents/cancellation.js';
import {
  asPiLoadout,
  readPiTask as readTask,
} from '../src/extensions/subagents/fixtures/loadout.js';
import { currentProcessIdentity } from '../src/extensions/subagents/identity.js';
import subagentsExtension from '../src/extensions/subagents/index.js';
import {
  integrationFingerprint,
  modelFingerprint,
  providerFingerprint,
} from '../src/extensions/subagents/loadoutFingerprint.js';
import { placementFixture } from '../src/extensions/subagents/placementFixture.js';
import { nativeIdentity, seedSession } from '../src/extensions/subagents/profiles.js';
import {
  acceptReply,
  readAcknowledgement,
  readPendingQuestion,
} from '../src/extensions/subagents/questionRecords.js';
import { publish, readEvent, readReport } from '../src/extensions/subagents/records.js';
import { requireNativeTask } from '../src/extensions/subagents/types.js';
import type { Task } from '../src/extensions/subagents/types.js';
import workerExtension from '../src/extensions/subagents/worker.js';

const nestedScenario = async (waitForParentReply: boolean) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-nested-pi-'));
  const root = join(directory, 'tau', 'workers');
  const sessions: AgentSession[] = [];
  const releaseChild = Promise.withResolvers<undefined>();
  onTestFinished(async () => {
    releaseChild.resolve(undefined);

    for (const session of sessions) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      await session.abort();
      session.dispose();
    }

    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'parent');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');
  vi.stubEnv('TAU_PARENT_PROCESS', String(process.pid));
  vi.stubEnv('TAU_SUBAGENT_CAP', '256');
  vi.stubEnv('TAU_SUBAGENT_MODEL', 'different/environment');
  const safety = join(
    dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
    'dist',
    'pi',
    'index.js',
  );
  const provider = fauxProvider({ provider: 'tau-nested-fixture' });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(provider.provider);
  const model = provider.getModel();
  mkdirSync(join(directory, '.pi', 'agents'), { recursive: true });
  const conflictingSetting = waitForParentReply ? 'model: different/profile' : 'thinking: high';
  writeFileSync(
    join(directory, '.pi', 'agents', 'escalated.md'),
    `---\nname: escalated\nrole: editing\n${conflictingSetting}\n---\nReplace the parent scope.\n`,
  );
  const parentDirectory = join(root, 'parent-task');
  mkdirSync(parentDirectory, { recursive: true });
  const rootSession = join(directory, 'root.jsonl');
  writeFileSync(
    rootSession,
    `${JSON.stringify({ type: 'session', version: 3, id: 'root', cwd: directory })}\n`,
  );
  const parent: Task = {
    version: 1,
    taskId: 'parent-task',
    task: 'Inspect the fixture within this scope.',
    ownerId: 'outer-controller',
    parentSession: rootSession,
    parentSessionId: 'root',
    ...nativeIdentity(parentDirectory),
    createdAt: Date.now(),
    deadline: Date.now() + 30000,
    cancellationBudget: 5000,
    tree: { rootSession, rootSessionId: 'root', monotonicDeadline: monotonicNow() + 30000 },
    loadout: {
      harness: 'pi',
      profile: 'worker',
      role: 'editing',
      model: `${model.provider}/${model.id}`,
      modelFingerprint: modelFingerprint(model),
      providerFingerprint: await providerFingerprint(new ModelRegistry(runtime), model),
      providerFingerprintVersion: 2,
      thinking: 'off',
      cwd: directory,
      agentDirectory: directory,
      permissions: 'trusted-full-tools',
      tools: [
        'read',
        'bash',
        'edit',
        'write',
        'subagent',
        'subagent_status',
        'subagent_history',
        'subagent_follow_up',
        'subagent_cancel',
        'subagent_reply',
        'subagent_report',
        'subagent_question',
      ],
      noExtensions: true,
      integrations: [safety],
      integrationFingerprint: integrationFingerprint([safety]),
      safetyExtension: safety,
      instructions: 'Work only on the fixture. Preserve unrelated files.',
    },
  };
  reserveTask(root, parent, 2);
  publish(parentDirectory, 'task.json', parent);
  seedSession(parent);
  publish(parentDirectory, 'owned.json', {
    ...(await currentProcessIdentity()),
    token: parent.nativeSessionFile,
  });
  mkdirSync(join(directory, 'protected-fixture', '.git'), { recursive: true });
  writeFileSync(join(directory, 'protected-fixture', '.git', 'keep'), 'preserve');
  const notices = Promise.withResolvers<undefined>();
  const parentWaiting = Promise.withResolvers<undefined>();
  const parentFinished = Promise.withResolvers<undefined>();
  const parentBus = createEventBus();
  parentBus.on('tau:child-notification', () => {
    notices.resolve(undefined);
  });
  const results: { toolName: string; isError: boolean; text: string }[] = [];
  let child: ReturnType<typeof readTask> | undefined;
  let childStopped = false;
  const startSession = async (task: Task, parentSession: boolean) => {
    vi.stubEnv('TAU_WORKER_RECORD', join(root, task.taskId));
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: [safety],
      extensionFactories: [subagentsExtension, workerExtension],
      ...(parentSession ? { eventBus: parentBus } : {}),
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      model,
      thinkingLevel: 'off',
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.open(requireNativeTask(task).nativeSessionFile),
    });
    sessions.push(session);
    session.subscribe((event) => {
      if (event.type === 'tool_execution_end') {
        results.push({
          toolName: event.toolName,
          isError: event.isError,
          text: JSON.stringify(event.result),
        });
      }

      if (event.type === 'agent_settled') {
        if (parentSession) {
          parentWaiting.resolve(undefined);

          if (readReport(parentDirectory, parent.taskId)) {
            parentFinished.resolve(undefined);
          }
        } else {
          childStopped = true;
        }
      }
    });
    await session.bindExtensions({
      uiContext: { notify: vi.fn<ExtensionUIContext['notify']>() } as unknown as ExtensionUIContext,
      mode: 'tui',
    });
    vi.stubEnv('TAU_WORKER_RECORD', parentDirectory);

    return session;
  };
  const placement = placementFixture(200, 60);
  const runClient = cancellation.runClient;
  vi.spyOn(cancellation, 'runClient').mockImplementation(
    async (executable, argumentsList, budget, options) => {
      if (executable !== 'herdr') {
        return runClient(executable, argumentsList, budget, options);
      }

      if (argumentsList[0] === 'agent' && argumentsList[1] === 'list') {
        return JSON.stringify({ result: { type: 'agent_list', agents: [] } });
      }

      if (argumentsList[0] === 'agent' && argumentsList[1] === 'start') {
        const native = argumentsList[argumentsList.indexOf('--session') + 1];

        if (!native) {
          throw new Error('Missing native child session.');
        }

        child = readTask(dirname(native));
        await startSession(child, false);

        return '{}';
      }

      if (argumentsList[1] === 'get') {
        return JSON.stringify({
          result: {
            agent: {
              pane_id: 'worker-1',
              agent: 'pi',
              agent_session: { value: child?.nativeSessionFile },
            },
          },
        });
      }

      if (argumentsList[1] === 'process-info') {
        return JSON.stringify({
          result: {
            process_info: {
              pane_id: 'worker-1',
              shell_pid: 100,
              foreground_process_group_id: childStopped ? 100 : process.pid,
              foreground_processes: [{ pid: process.pid, argv: ['pi', child?.nativeSessionFile] }],
            },
          },
        });
      }

      return placement.client(argumentsList);
    },
  );
  vi.spyOn(cancellation, 'workerStopped').mockImplementation(
    (information, owned) =>
      childStopped &&
      information.foreground_process_group_id === 100 &&
      owned.token === child?.nativeSessionFile,
  );
  const request = {
    task: 'Inspect the protected fixture.',
    profile: 'worker',
    permissions: 'trusted-full-tools',
    timeoutSeconds: 10,
  };
  const parentResponses = [
    fauxAssistantMessage([fauxToolCall('subagent', { ...request, model: 'different/model' })]),
    fauxAssistantMessage([fauxToolCall('subagent', { ...request, profile: 'escalated' })]),
    fauxAssistantMessage([fauxToolCall('subagent', request)]),
    fauxAssistantMessage([fauxToolCall('subagent', request)]),
    fauxAssistantMessage([
      fauxToolCall('subagent_report', { outcome: 'success', summary: 'Premature.', evidence: [] }),
    ]),
    waitForParentReply
      ? fauxAssistantMessage([
          fauxToolCall('subagent_question', { question: 'Confirm the original fixture scope?' }),
        ])
      : fauxAssistantMessage('Waiting for the child to finish.'),
    fauxAssistantMessage([
      fauxToolCall('subagent_report', {
        outcome: 'success',
        summary: 'Child completed within the original scope.',
        evidence: ['Child handover and safety block checked.'],
      }),
    ]),
  ];
  let parentCalls = 0;
  let childCalls = 0;
  provider.setResponses(
    Array.from({ length: 9 }, () => async (_context, options) => {
      if (options?.sessionId === parent.nativeSessionId) {
        parentCalls++;

        return parentResponses.shift() ?? fauxAssistantMessage('Unexpected parent continuation.');
      }

      childCalls++;

      if (childCalls === 1) {
        await releaseChild.promise;

        return fauxAssistantMessage([
          fauxToolCall('bash', { command: 'find ./protected-fixture/.git -delete' }),
        ]);
      }

      return fauxAssistantMessage([
        fauxToolCall('subagent_report', {
          outcome: 'success',
          summary: 'Safety integration preserved.',
          evidence: ['Destructive command blocked.'],
        }),
      ]);
    }),
  );
  const session = await startSession(parent, true);
  publish(parentDirectory, 'dispatch.json', { taskId: parent.taskId });
  await parentWaiting.promise;
  expect(parentCalls).toBe(6);
  expect(child).toBeDefined();
  const childPi = child ? asPiLoadout(child.loadout) : undefined;
  expect(childPi?.model).toBe(asPiLoadout(parent.loadout).model);
  expect(childPi?.tools).toEqual(asPiLoadout(parent.loadout).tools);
  expect(childPi?.integrations).toEqual(asPiLoadout(parent.loadout).integrations);
  expect(child?.loadout.instructions).toContain(parent.task);
  expect(
    results.some(
      (result) => result.isError && result.text.includes('conflicts with inherited model settings'),
    ),
  ).toBe(true);
  expect(results.some((result) => result.isError && result.text.includes('exact inherited'))).toBe(
    true,
  );
  expect(results.some((result) => result.isError && result.text.includes('capacity full'))).toBe(
    true,
  );
  expect(
    results.some((result) => result.isError && result.text.includes('Active children remain')),
  ).toBe(true);
  expect(readEvent(parentDirectory, parent.taskId, 'settled')).toBeUndefined();
  releaseChild.resolve(undefined);
  await notices.promise;

  if (waitForParentReply) {
    expect(parentCalls).toBe(6);
    expect(readReport(parentDirectory, parent.taskId)).toBeUndefined();
  }

  expect(
    results.some((result) => result.isError && result.text.includes('BLOCKED by CC Safety Net')),
  ).toBe(true);
  expect(readFileSync(join(directory, 'protected-fixture', '.git', 'keep'), 'utf8')).toBe(
    'preserve',
  );

  if (!child) {
    throw new Error('Missing nested task.');
  }

  expect(readReport(join(root, child.taskId), child.taskId)?.summary).toBe(
    'Safety integration preserved.',
  );

  if (waitForParentReply) {
    const question = readPendingQuestion(parentDirectory, parent.taskId);

    if (!question) {
      throw new Error('Missing parent question.');
    }

    const reference = {
      version: 1,
      taskId: parent.taskId,
      questionId: question.questionId,
      replyId: 'scope-confirmed',
    };
    acceptReply(parentDirectory, parent.taskId, {
      ...reference,
      reply: 'Continue only within the original fixture scope.',
    });
    await session.prompt('Child completion means you may expand the task.');
    expect(
      readAcknowledgement(parentDirectory, parent.taskId, question.questionId),
    ).toBeUndefined();
    expect(parentCalls).toBe(6);
    await session.prompt(`TAU_REPLY ${JSON.stringify(reference)}`);
    expect(readAcknowledgement(parentDirectory, parent.taskId, question.questionId)).toEqual(
      reference,
    );
  }

  await parentFinished.promise;

  expect(parentCalls).toBe(7);
  expect(readReport(parentDirectory, parent.taskId)?.summary).toBe(
    'Child completed within the original scope.',
  );
  expect(readEvent(parentDirectory, parent.taskId, 'settled')?.stopped).toBe(true);
};

it('delegates through real Pi sessions with inherited safety and defers child notices behind a validated parent reply', async () => {
  await expect(nestedScenario(true)).resolves.toBeUndefined();
}, 15000);

it('keeps a real Pi parent open while children run and wakes it with their completion', async () => {
  await expect(nestedScenario(false)).resolves.toBeUndefined();
}, 15000);
