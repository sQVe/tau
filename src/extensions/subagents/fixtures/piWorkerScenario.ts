import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  ModelRuntime,
  ModelRegistry,
  DefaultResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { expect, onTestFinished, vi } from 'vitest';

import { runClient } from '../cancellation.js';
import { WorkerController } from '../controller/controller.js';
import { searchHistory } from '../history.js';
import { resolveLoadout, validateSavedLoadout } from '../loadout.js';
import { readAcknowledgement, readReply } from '../questionRecords.js';
import { requireObject, result, terminalLocation } from '../terminal.js';
import { fixtureModel } from './controlledProvider.js';
import { isolatedHerdr } from './isolatedHerdr.js';
import { readPiTask as readTask } from './loadout.js';
import { toolAvailable } from './toolAvailable.js';

export type PiWorkerScenario =
  | 'completion'
  | 'follow-up'
  | 'active cancellation'
  | 'moved cancellation'
  | 'active timeout'
  | 'early exit'
  | 'question completion'
  | 'question cancellation'
  | 'question timeout';

export const canRunPiWorker = toolAvailable('herdr') && toolAvailable('pi');

export const piWorkerTimeout = 40_000;

export const runPiWorkerScenario = async (scenario: PiWorkerScenario) => {
  const { root, environment, client: isolatedClient } = await isolatedHerdr();
  const completes = ['completion', 'question completion', 'follow-up'].includes(scenario);
  writeFileSync(
    join(root, 'parent.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 'parent', cwd: root }) + '\n',
  );
  writeFileSync(
    join(environment.PI_CODING_AGENT_DIR, 'settings.json'),
    JSON.stringify({ defaultProjectTrust: 'trusted', retry: { enabled: false } }),
  );
  writeFileSync(join(root, 'source.txt'), 'before\n');
  mkdirSync(join(root, 'delete-fixture', '.git'), { recursive: true });
  writeFileSync(join(root, 'delete-fixture', '.git', 'keep'), 'preserve');
  const exitSignal = join(root, 'exit-before-ready');
  const earlyExitExtension = join(root, 'early-exit.js');
  writeFileSync(
    earlyExitExtension,
    `import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
export default function (pi) {
  pi.on('session_start', async () => {
    while (!existsSync(${JSON.stringify(exitSignal)})) { await delay(25); }
    process.exit(23);
  });
}`,
  );
  const observations: string[] = [];
  const deliveryEntered = Promise.withResolvers<undefined>();
  const releaseDelivery = Promise.withResolvers<undefined>();
  let promptCount = 0;
  const client = async (argumentsList: string[], budget = 5000, signal?: AbortSignal) => {
    if (argumentsList[1] === 'prompt') {
      promptCount += 1;
      deliveryEntered.resolve(undefined);
      await releaseDelivery.promise;
    }

    const response = await isolatedClient(argumentsList, budget, signal);
    observations.push(response);

    // The early-exit fixture leaves during startup, before herdr reports the worker session.
    if (scenario === 'early exit' && argumentsList[1] === 'start') {
      writeFileSync(exitSignal, 'exit');
    }

    return response;
  };
  await runClient('herdr', ['integration', 'install', 'pi'], 5000, { environment });
  const workspace: unknown = JSON.parse(
    await client(['workspace', 'create', '--cwd', root, '--no-focus']),
  );
  const workspaceText = JSON.stringify(workspace);
  const paneId = workspaceText.match(/"root_pane":\{[^}]*"pane_id":"([^"]+)"/)?.[1];

  if (!paneId) {
    throw new Error(`Missing parent pane: ${workspaceText}`);
  }

  if (scenario === 'moved cancellation') {
    await client(['pane', 'move', paneId, '--new-workspace', '--no-focus']);
  }

  const safety = join(
    dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
    'dist',
    'pi',
    'index.js',
  );
  // A second entry point simulates duplicate package registration without disabling either handler.
  const secondSafety = join(root, 'second-safety.mjs');
  writeFileSync(secondSafety, `export { default } from ${JSON.stringify(safety)};`);
  const provider = fileURLToPath(new URL('./controlledProvider.ts', import.meta.url));
  const integration = join(environment.PI_CODING_AGENT_DIR, 'extensions', 'herdr-agent-state.ts');
  writeFileSync(
    join(environment.PI_CODING_AGENT_DIR, 'auth.json'),
    JSON.stringify({
      'tau-worker-fixture': { type: 'api_key', key: 'fixture-key-not-a-secret' },
    }),
  );
  const runtime = await ModelRuntime.create({
    authPath: join(environment.PI_CODING_AGENT_DIR, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const extensions = [provider, safety, secondSafety, integration];

  if (scenario === 'early exit') {
    extensions.push(earlyExitExtension);
  }

  // Pi discovers only .ts and .js files in the agent extensions directory.
  for (const [index, extension] of extensions.entries()) {
    if (extension !== integration) {
      writeFileSync(
        join(environment.PI_CODING_AGENT_DIR, 'extensions', `fixture-${index}.js`),
        `export { default } from ${JSON.stringify(extension)};\n`,
      );
    }
  }

  const parentLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: environment.PI_CODING_AGENT_DIR,
    noExtensions: true,
    additionalExtensionPaths: extensions,
  });
  await parentLoader.reload();

  for (const registration of parentLoader.getExtensions().runtime
    .pendingNativeProviderRegistrations) {
    runtime.registerNativeProvider(registration.provider);
  }

  await runtime.getAvailable();
  vi.stubEnv('PI_CODING_AGENT_DIR', environment.PI_CODING_AGENT_DIR);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  mkdirSync(join(root, '.pi', 'agents'), { recursive: true });
  writeFileSync(
    join(root, '.pi', 'agents', 'worker.md'),
    '---\nname: worker\nrole: editing\nthinking: off\n---\nComplete only the fixture task.\n',
  );
  const loadout = resolveLoadout(
    {
      profile: 'worker',
      model: `${fixtureModel.provider}/${fixtureModel.id}`,
      permissions: 'trusted-full-tools',
    },
    {
      cwd: root,
      modelRegistry: new ModelRegistry(runtime),
      scopedModels: [],
      isProjectTrusted: () => true,
    },
  );
  let done = Promise.withResolvers<string>();
  const questionAsked = Promise.withResolvers<undefined>();
  const controller = new WorkerController(join(root, 'records'), client, (notice) => {
    if (notice.question) {
      questionAsked.resolve(undefined);
    } else {
      done.resolve(JSON.stringify(notice.content));
    }
  });
  onTestFinished(() => {
    controller.close();
  });
  let taskText =
    scenario === 'completion' || scenario === 'follow-up'
      ? 'Edit and check only the fixture.'
      : 'Test active cancellation.';

  if (scenario.startsWith('question')) {
    taskText = 'Ask a question then edit and check only the fixture.';
  }

  const launchedAt = performance.now();
  const launched = await controller.launch({
    task: taskText,
    timeout: scenario === 'early exit' ? 60_000 : 10_000,
    parentSession: join(root, 'parent.jsonl'),
    parentSessionId: 'parent',
    parentPane: paneId,
    loadout,
  });
  const failure = scenario === 'early exit' ? /exited before readiness/ : /^$/;
  expect(performance.now() - launchedAt).toBeLessThan(10_000);
  expect(launched.failure ?? '').toMatch(failure);
  expect(existsSync(join(launched.directory, 'dispatch.json'))).toBe(scenario !== 'early exit');
  let movement: { sameTerminal: boolean; newPane: boolean } | undefined;

  if (scenario === 'active cancellation' || scenario === 'moved cancellation') {
    const streamingDeadline = performance.now() + 10_000;

    while (!existsSync(join(root, 'streaming'))) {
      if (performance.now() > streamingDeadline) {
        throw new Error('Worker never entered active streaming.');
      }

      await delay(25);
    }

    if (scenario === 'moved cancellation') {
      const owned = requireObject(
        JSON.parse(readFileSync(join(launched.directory, 'owned.json'), 'utf8')),
      );
      const moved = requireObject(
        result(
          await client(['pane', 'move', String(owned.paneId), '--new-workspace', '--no-focus']),
        ).move_result,
      );
      const location = terminalLocation(moved.pane);

      movement = {
        sameTerminal: location.terminalId === owned.terminalId,
        newPane: location.paneId !== owned.paneId,
      };
    }

    await controller.cancel(launched.taskId, 'parent');
  }

  const savedTask = readTask(launched.directory);
  const questionObservations: unknown[] = [];
  const replyObservations: unknown[] = [];
  let askedQuestionId: string | undefined;

  if (scenario.startsWith('question')) {
    await questionAsked.promise;
    const waiting = controller.status(launched.taskId, 'parent');
    const task = readTask(launched.directory);
    const question = waiting.pendingQuestion;

    if (!question) {
      throw new Error('No pending worker question.');
    }

    askedQuestionId = question.questionId;
    questionObservations.push(
      waiting.state,
      readFileSync(join(root, 'source.txt'), 'utf8'),
      waiting.deadline,
    );
    const answer = {
      questionId: question.questionId,
      replyId: 'reply-one',
      reply: 'Yes. Edit only the fixture.',
      scopeUnchanged: true,
    };

    if (scenario === 'question completion') {
      const delivering = controller.reply(task.taskId, 'parent', answer);
      await deliveryEntered.promise;
      const repeated = await controller.reply(task.taskId, 'parent', answer);

      if (!('workerAcknowledged' in repeated)) {
        throw new Error('Expected a Pi reply receipt.');
      }

      replyObservations.push(
        readReply(launched.directory, task.taskId, question.questionId)?.replyId,
        readAcknowledgement(launched.directory, task.taskId, question.questionId),
        repeated.workerAcknowledged,
        promptCount,
      );
      releaseDelivery.resolve(undefined);
      await delivering;
    } else if (scenario === 'question cancellation') {
      await controller.cancel(task.taskId, 'parent');
    }
  }

  expect(movement).toEqual(
    scenario === 'moved cancellation' ? { sameTerminal: true, newPane: true } : undefined,
  );
  await done.promise;
  const status = controller.status(launched.taskId, 'parent');

  expect(questionObservations).toEqual(
    scenario.startsWith('question') ? ['awaitingReply', 'before\n', launched.deadline] : [],
  );
  expect(replyObservations).toEqual(
    scenario === 'question completion' ? ['reply-one', undefined, false, 1] : [],
  );
  const acknowledgement = askedQuestionId
    ? readAcknowledgement(launched.directory, launched.taskId, askedQuestionId)
    : undefined;
  expect(acknowledgement?.replyId).toBe(
    scenario === 'question completion' ? 'reply-one' : undefined,
  );
  expect(readTask(launched.directory)).toEqual(savedTask);
  expect(status.failure ?? '').toMatch(failure);
  expect({ status, observations }).toMatchObject({
    status: {
      outcome: {
        completion: 'success',
        'follow-up': 'success',
        'active cancellation': 'cancelled',
        'moved cancellation': 'cancelled',
        'active timeout': 'timeout',
        'early exit': 'failure',
        'question completion': 'success',
        'question cancellation': 'cancelled',
        'question timeout': 'timeout',
      }[scenario],
      state: 'stopped',
    },
  });
  expect(status.cleanup).toContain('pane closed');
  expect(status.report?.evidence ?? []).toEqual(
    completes ? ['edit checked', 'Safety Net block: true'] : [],
  );
  expect(readFileSync(join(root, 'source.txt'), 'utf8')).toBe(completes ? 'after\n' : 'before\n');
  expect(readFileSync(join(root, 'delete-fixture', '.git', 'keep'), 'utf8')).toBe('preserve');
  const followUpObservations: unknown[] = [];

  if (scenario === 'follow-up') {
    const taskBytes = readFileSync(join(launched.directory, 'task.json'));
    const reportBytes = readFileSync(join(launched.directory, 'report.json'));
    const transcript = readFileSync(savedTask.nativeSessionFile, 'utf8');
    const profilePath = join(root, '.pi', 'agents', 'worker.md');
    writeFileSync(profilePath, 'Changed invalid profile.');
    const replayed = validateSavedLoadout(savedTask.loadout, {
      cwd: root,
      modelRegistry: new ModelRegistry(runtime),
      isProjectTrusted: () => true,
    });
    rmSync(profilePath);
    done = Promise.withResolvers<string>();
    const next = await controller.followUp(
      {
        sourceTaskId: savedTask.taskId,
        task: 'Follow up and verify prior context.',
        timeout: 10000,
        settingsUnchanged: true,
        parentSession: savedTask.parentSession,
        parentSessionId: savedTask.parentSessionId,
        parentPane: paneId,
      },
      { cwd: root, modelRegistry: new ModelRegistry(runtime), isProjectTrusted: () => true },
    );
    await done.promise;
    const final = controller.status(next.taskId, 'parent');
    const nextTask = readTask(next.directory);
    const history = await searchHistory(join(root, 'records'), {
      file: savedTask.parentSession,
      id: 'parent',
      sessionDirectory: root,
    });

    followUpObservations.push(
      nextTask.taskId !== savedTask.taskId,
      nextTask.deadline !== savedTask.deadline,
      {
        predecessorTaskId: nextTask.predecessorTaskId,
        nativeSessionId: nextTask.nativeSessionId,
        nativeSessionFile: nextTask.nativeSessionFile,
        loadout: nextTask.loadout,
      },
      final.outcome,
      final.state,
      final.report?.evidence,
      readFileSync(join(launched.directory, 'task.json')).equals(taskBytes),
      readFileSync(join(launched.directory, 'report.json')).equals(reportBytes),
      readFileSync(savedTask.nativeSessionFile, 'utf8').startsWith(transcript),
      [savedTask.taskId, nextTask.taskId].every((id) =>
        history.candidates.some((candidate) => candidate.taskId === id),
      ),
      readFileSync(join(root, 'delete-fixture', '.git', 'keep'), 'utf8'),
      replayed,
    );
  }

  expect(followUpObservations).toEqual(
    scenario === 'follow-up'
      ? [
          true,
          true,
          {
            predecessorTaskId: savedTask.taskId,
            nativeSessionId: savedTask.nativeSessionId,
            nativeSessionFile: savedTask.nativeSessionFile,
            loadout: savedTask.loadout,
          },
          'success',
          'stopped',
          ['prior context: true', 'Safety Net block: true', 'saved instructions: true'],
          true,
          true,
          true,
          true,
          'preserve',
          loadout,
        ]
      : [],
  );
};
