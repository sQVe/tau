import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  ModelRuntime,
  ModelRegistry,
  DefaultResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { runClient } from '../src/extensions/subagents/cancellation.js';
import { WorkerController } from '../src/extensions/subagents/controller.js';
import { fixtureModel } from '../src/extensions/subagents/fixtures/controlledProvider.js';
import { searchHistory } from '../src/extensions/subagents/history.js';
import { resolveLoadout, validateSavedLoadout } from '../src/extensions/subagents/loadout.js';
import { readAcknowledgement, readReply, readTask } from '../src/extensions/subagents/records.js';

const hasHerdr = spawnSync('herdr', ['--version'], { timeout: 2000, stdio: 'ignore' }).status === 0;
const hasPi = spawnSync('pi', ['--version'], { timeout: 2000, stdio: 'ignore' }).status === 0;

it
  .runIf(hasHerdr && hasPi)
  .each([
    'completion',
    'follow-up',
    'active cancellation',
    'active timeout',
    'early exit',
    'question completion',
    'question cancellation',
    'question timeout',
  ])(
  'runs real canonical Pi %s with Safety Net in isolated herdr',
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'tau-herdr-worker-'));
    const completes = ['completion', 'question completion', 'follow-up'].includes(scenario);
    writeFileSync(
      join(root, 'parent.jsonl'),
      JSON.stringify({ type: 'session', version: 3, id: 'parent', cwd: root }) + '\n',
    );
    const environment = {
      // oxlint-disable-next-line node/no-process-env -- Only executable lookup is inherited; the active herdr socket and user resources are excluded.
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      HERDR_CONFIG_PATH: join(root, 'herdr.toml'),
      PI_CODING_AGENT_DIR: join(root, 'agent'),
      SHELL: '/bin/sh',
      TERM: 'xterm-256color',
    };
    mkdirSync(environment.PI_CODING_AGENT_DIR);
    writeFileSync(
      environment.HERDR_CONFIG_PATH,
      'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n',
    );
    const disabledExtension = join(root, 'disabled-package.js');
    const rediscovered = join(root, 'rediscovered');
    writeFileSync(
      disabledExtension,
      `import { writeFileSync } from 'node:fs';\nexport default function () { writeFileSync(${JSON.stringify(rediscovered)}, 'unexpected discovery'); }`,
    );
    writeFileSync(
      join(environment.PI_CODING_AGENT_DIR, 'settings.json'),
      JSON.stringify({
        defaultProjectTrust: 'trusted',
        retry: { enabled: false },
        packages: [disabledExtension],
      }),
    );
    writeFileSync(join(root, 'source.txt'), 'before\n');
    mkdirSync(join(root, 'delete-fixture', '.git'), { recursive: true });
    writeFileSync(join(root, 'delete-fixture', '.git', 'keep'), 'preserve');
    const server = spawn('herdr', ['--session', 'tau-worker-test', 'server'], {
      env: environment,
      stdio: 'ignore',
    });
    const exited = once(server, 'exit');
    onTestFinished(async () => {
      server.kill('SIGTERM');
      await exited;
      rmSync(root, { recursive: true, force: true });
    });
    const readyDeadline = performance.now() + 10_000;
    while (
      !existsSync(join(root, 'config', 'herdr', 'sessions', 'tau-worker-test', 'herdr.sock'))
    ) {
      if (performance.now() > readyDeadline) {
        throw new Error('Isolated herdr did not start.');
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Real socket readiness is bounded by the test deadline.
      await delay(25);
    }
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
    let taskDirectory = '';
    const observations: string[] = [];
    const deliveryEntered = Promise.withResolvers<undefined>();
    const releaseDelivery = Promise.withResolvers<undefined>();
    let promptCount = 0;
    const client = async (arguments_: string[], budget = 5000, signal?: AbortSignal) => {
      if (arguments_[1] === 'start') {
        taskDirectory = dirname(arguments_[arguments_.indexOf('--session') + 1] ?? '');
      }
      if (arguments_[1] === 'prompt') {
        promptCount += 1;
        deliveryEntered.resolve(undefined);
        await releaseDelivery.promise;
      }
      const response = await runClient(
        'herdr',
        ['--session', 'tau-worker-test', ...arguments_],
        budget,
        signal,
        environment,
      );
      observations.push(response);
      if (
        scenario === 'early exit' &&
        arguments_[1] === 'process-info' &&
        existsSync(join(taskDirectory, 'owned.json'))
      ) {
        writeFileSync(exitSignal, 'exit');
      }

      return response;
    };
    await runClient('herdr', ['integration', 'install', 'pi'], 5000, undefined, environment);
    const workspace: unknown = JSON.parse(
      await client(['workspace', 'create', '--cwd', root, '--no-focus']),
    );
    const workspaceText = JSON.stringify(workspace);
    const paneId = workspaceText.match(/"root_pane":\{[^}]*"pane_id":"([^"]+)"/)?.[1];
    if (!paneId) {
      throw new Error(`Missing parent pane: ${workspaceText}`);
    }
    const safety = join(
      dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
      'dist',
      'pi',
      'index.js',
    );
    const provider = fileURLToPath(
      new URL('../src/extensions/subagents/fixtures/controlledProvider.ts', import.meta.url),
    );
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
    const extensions = [
      provider,
      safety,
      integration,
      ...(scenario === 'early exit' ? [earlyExitExtension] : []),
    ];
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
    const originalArguments = process.argv;
    process.argv = [
      process.execPath,
      'pi',
      '--no-extensions',
      ...extensions.flatMap((path) => ['-e', path]),
    ];
    vi.stubEnv('PI_CODING_AGENT_DIR', environment.PI_CODING_AGENT_DIR);
    onTestFinished(() => {
      process.argv = originalArguments;
      vi.unstubAllEnvs();
    });
    mkdirSync(join(root, '.pi', 'agents'), { recursive: true });
    writeFileSync(
      join(root, '.pi', 'agents', 'worker.md'),
      '---\nname: worker\nrole: editing\nthinking: off\n---\nComplete only the fixture task.\n',
    );
    const loadout = await resolveLoadout(
      {
        profile: 'worker',
        model: `${fixtureModel.provider}/${fixtureModel.id}`,
        permissions: 'trusted-full-tools',
      },
      { cwd: root, modelRegistry: new ModelRegistry(runtime), isProjectTrusted: () => true },
      {
        getAllTools: () => [],
        getCommands: () => [
          {
            name: 'fixture-skill',
            description: 'Not an extension',
            source: 'skill',
            sourceInfo: {
              path: join(root, 'SKILL.md'),
              source: 'test',
              scope: 'temporary',
              origin: 'top-level',
            },
          },
        ],
      },
    );
    let done = Promise.withResolvers<string>();
    const questionAsked = Promise.withResolvers<undefined>();
    const controller = new WorkerController(join(root, 'records'), client, (message, question) => {
      if (question) {
        questionAsked.resolve(undefined);
      } else {
        done.resolve(message);
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
    if (scenario === 'active cancellation') {
      const streamingDeadline = performance.now() + 10_000;
      while (!existsSync(join(root, 'streaming'))) {
        if (performance.now() > streamingDeadline) {
          throw new Error('Worker never entered active streaming.');
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for a real child streaming signal, not an assumed startup delay.
        await delay(25);
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
        waiting.stopped,
        waiting.reportAccepted,
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
        replyObservations.push(
          readReply(launched.directory, task.taskId, question.questionId)?.replyId,
          readAcknowledgement(launched.directory, task.taskId, question.questionId),
          (await controller.reply(task.taskId, 'parent', answer)).workerAcknowledged,
          promptCount,
        );
        releaseDelivery.resolve(undefined);
        await delivering;
      } else if (scenario === 'question cancellation') {
        await controller.cancel(task.taskId, 'parent');
      }
    }
    await done.promise;
    const status = controller.status(launched.taskId, 'parent');

    expect(questionObservations).toEqual(
      scenario.startsWith('question') ? [false, false, 'before\n', launched.deadline] : [],
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
    expect(existsSync(rediscovered)).toBe(false);
    expect(loadout.noExtensions).toBe(true);
    expect({ status, observations }).toMatchObject({
      status: {
        outcome: {
          completion: 'success',
          'follow-up': 'success',
          'active cancellation': 'cancelled',
          'active timeout': 'timeout',
          'early exit': 'failure',
          'question completion': 'success',
          'question cancellation': 'cancelled',
          'question timeout': 'timeout',
        }[scenario],
        ready: scenario !== 'early exit',
        accepted: scenario !== 'early exit',
        reportAccepted: completes,
        stopped: true,
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
      const replayed = await validateSavedLoadout(savedTask.loadout, {
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
        final.stopped,
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
            true,
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
  },
  40_000,
);
