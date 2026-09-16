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

import { runClient } from './cancellation.js';
import { WorkerController } from './controller.js';
import { fixtureModel } from './fixtures/controlledProvider.js';
import { resolveLoadout } from './loadout.js';

const hasHerdr = spawnSync('herdr', ['--version'], { timeout: 2000, stdio: 'ignore' }).status === 0;
const hasPi = spawnSync('pi', ['--version'], { timeout: 2000, stdio: 'ignore' }).status === 0;

it.runIf(hasHerdr && hasPi).each(['completion', 'active cancellation', 'active timeout'])(
  'runs real canonical Pi %s with Safety Net in isolated herdr',
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'tau-herdr-worker-'));
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
    writeFileSync(
      join(environment.PI_CODING_AGENT_DIR, 'settings.json'),
      JSON.stringify({ defaultProjectTrust: 'trusted', retry: { enabled: false } }),
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
    const observations: string[] = [];
    const client = async (arguments_: string[], budget = 5000, signal?: AbortSignal) => {
      const response = await runClient(
        'herdr',
        ['--session', 'tau-worker-test', ...arguments_],
        budget,
        signal,
        environment,
      );
      observations.push(response);

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
    const provider = fileURLToPath(new URL('./fixtures/controlledProvider.ts', import.meta.url));
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
    const parentLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: environment.PI_CODING_AGENT_DIR,
      additionalExtensionPaths: [provider, safety, integration],
    });
    await parentLoader.reload();
    for (const registration of parentLoader.getExtensions().runtime
      .pendingNativeProviderRegistrations) {
      runtime.registerNativeProvider(registration.provider);
    }
    await runtime.getAvailable();
    const originalArguments = process.argv;
    process.argv = [process.execPath, 'pi', '-e', safety, '-e', provider, '-e', integration];
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
    const done = Promise.withResolvers<string>();
    const controller = new WorkerController(join(root, 'records'), client, (message) => {
      done.resolve(message);
    });
    onTestFinished(() => {
      controller.close();
    });
    const launched = await controller.launch({
      task:
        scenario === 'completion'
          ? 'Edit and check only the fixture.'
          : 'Test active cancellation.',
      timeout: 10_000,
      parentSession: join(root, 'parent.jsonl'),
      parentSessionId: 'parent',
      parentPane: paneId,
      loadout,
    });
    expect(launched.failure).toBeUndefined();
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
    await done.promise;
    const status = controller.status(launched.taskId, 'parent');

    expect(status.failure).toBeUndefined();
    expect({ status, observations }).toMatchObject({
      status: {
        outcome: {
          completion: 'success',
          'active cancellation': 'cancelled',
          'active timeout': 'timeout',
        }[scenario],
        ready: true,
        accepted: true,
        reportAccepted: scenario === 'completion',
        stopped: true,
      },
    });
    expect(status.cleanup).toContain('pane closed');
    expect(status.report?.evidence ?? []).toEqual(
      scenario === 'completion' ? ['edit checked', 'Safety Net block: true'] : [],
    );
    expect(readFileSync(join(root, 'source.txt'), 'utf8')).toBe(
      scenario === 'completion' ? 'after\n' : 'before\n',
    );
    expect(readFileSync(join(root, 'delete-fixture', '.git', 'keep'), 'utf8')).toBe('preserve');
  },
  40_000,
);
