import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentSessionEvent, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { buildTauExtension } from '../scripts/buildTauExtension.js';
import type { Assignment } from '../src/extensions/subagents/assignment.js';
import { workerArguments } from '../src/extensions/subagents/workerCommand.js';
import type { SpawnResult } from '../src/extensions/tdd/runner/types.js';
import { runTests } from '../src/extensions/tdd/runner/vitest.js';
import { runWithEnvironment } from '../src/hc/connect.js';
import { skillTools } from '../src/skillTools.js';
import { isTauRegistrationModule } from '../src/tau/tauSelection.js';
import { initializeRepository } from './gitRepository.js';
import { startHcSession } from './hcSessionHarness.js';
import { createBoundSession } from './piSession.js';
import { createHarness } from './tddHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const runnerFolder = join(packageRoot, 'src', 'extensions', 'tdd', 'runner') + '/';

const bundleFactory =
  (artifact: string): ExtensionFactory =>
  async (pi) => {
    const module: unknown = await import(pathToFileURL(artifact).href);

    if (!isTauRegistrationModule(module)) {
      throw new Error('The Tau artifact has no default registration.');
    }

    await module.default(pi);
  };

// The runner entry and the report reporter are both rebased from import.meta.url.
const runnerPaths = (command: readonly string[]): string[] =>
  command.flatMap((argument) => {
    const path = argument.startsWith('--reporter=')
      ? argument.slice('--reporter='.length)
      : argument;

    return path.startsWith(runnerFolder) ? [path] : [];
  });

const sourceCommand = async (): Promise<string[]> => {
  let command: string[] = [];

  const spawn = async (_executable: string, argumentsList: string[]): Promise<SpawnResult> => {
    command = argumentsList;

    return {
      stdout: '',
      stderr: '',
      code: 1,
      timedOut: false,
      command: argumentsList,
      started: true,
      stdoutTruncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
  };

  await runTests(
    {
      cwd: packageRoot,
      verificationArgv: ['vitest', 'run', '--reporter=json', '--reporter=default', '--no-color'],
      files: ['src/tau/tauSelection.test.ts'],
      testNames: ['loads the artifact only when its key matches the current source inputs'],
      scope: 'focused',
    },
    {
      resolveVitest: () => ({
        path: join(packageRoot, 'node_modules', 'vitest'),
        version: '4.1.11',
      }),
      spawn,
      timeoutMs: 5_000,
    },
  );

  return command;
};

it('runs the tdd runner with the same reporter and entry paths from the bundle as from source', async ({
  onTestFinished,
}) => {
  const artifact = await buildTauExtension(packageRoot);
  const expected = runnerPaths(await sourceCommand());

  const harness = await createHarness(onTestFinished, [], undefined, bundleFactory(artifact));
  const result = await harness.run();
  const command = result.details.report.diagnostics?.stages[0]?.command ?? [];

  expect(expected).toHaveLength(2);
  expect(runnerPaths(command)).toEqual(expected);
}, 120_000);

const writeWorkerFixture = async (
  agentDirectory: string,
  cwd: string,
  model: { provider: string; id: string },
): Promise<void> => {
  await mkdir(join(agentDirectory, 'agents'), { recursive: true });

  await writeFile(
    join(agentDirectory, 'tau.json'),
    JSON.stringify({ profiles: { worker: { model: `${model.provider}/${model.id}` } } }),
  );

  await writeFile(
    join(agentDirectory, 'agents', 'worker.md'),
    [
      '---',
      'name: worker',
      'role: editing',
      'tools: read, bash, edit, write',
      'thinking: off',
      '---',
      '',
      'Inspect the counters.',
      '',
    ].join('\n'),
  );

  await initializeRepository(cwd);
};

const writeRecordingPi = async (bin: string, argvPath: string): Promise<string> => {
  const executable = join(bin, 'pi');

  await writeFile(
    executable,
    [
      `#!${process.execPath}`,
      "import { renameSync, writeFileSync } from 'node:fs';",
      `const temporary = ${JSON.stringify(`${argvPath}.partial`)};`,
      `writeFileSync(temporary, JSON.stringify(process.argv));`,
      `renameSync(temporary, ${JSON.stringify(argvPath)});`,
      '',
    ].join('\n'),
  );

  await chmod(executable, 0o755);

  return executable;
};

// The launch reply arrives when hc starts the terminal, so the recorder may still be starting.
const readRecordedArguments = async (argvPath: string): Promise<string[]> => {
  await expect.poll(() => existsSync(argvPath), { timeout: 15_000 }).toBe(true);

  return JSON.parse(await readFile(argvPath, 'utf8')) as string[];
};

const launchArguments = (recorded: readonly string[], executable: string): string[] => {
  expect(recorded[1]).toBe(executable);

  const start = recorded.indexOf('--approve');

  expect(start).toBeGreaterThan(0);

  return recorded.slice(start);
};

it('builds the same worker entry paths from the bundle as from source', async ({
  onTestFinished,
}) => {
  const artifact = await buildTauExtension(packageRoot);
  const hc = await startHcSession(onTestFinished);
  const root = temporaryDirectory(onTestFinished, 'tau-bundle-worker-');
  const cwd = join(root, 'repository');
  const agentDirectory = join(root, 'agent');
  const bin = join(root, 'bin');
  const argvPath = join(root, 'worker-argv.json');

  await mkdir(agentDirectory, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const faux = fauxProvider({ provider: 'tau-bundle-worker' });
  const model = faux.getModel();

  await writeWorkerFixture(agentDirectory, cwd, model);

  const executable = await writeRecordingPi(bin, argvPath);

  for (const [name, value] of Object.entries(hc.environment)) {
    vi.stubEnv(name, value);
  }

  vi.stubEnv('PATH', `${bin}:${hc.environment['PATH'] ?? ''}`);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const manager = await runWithEnvironment(hc.runtime, {
    argv: ['sleep', '60'],
    name: 'manager',
    env: {},
  });

  vi.stubEnv('HC_TERMINAL_ID', manager.address);

  const { session } = await createBoundSession(onTestFinished, {
    cwd,
    agentDirectory,
    providers: [faux],
    extensionPaths: [artifact],
    sessionManager: SessionManager.create(cwd, join(root, 'sessions')),
    trusted: true,
  });

  const events: AgentSessionEvent[] = [];

  session.subscribe((event) => events.push(event));

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('subagent', {
        task: 'Inspect the counters.',
        profile: 'worker',
        acceptance: ['The counters are inspected.'],
      }),
    ]),
    fauxAssistantMessage('Done.'),
  ]);

  await session.prompt('Launch a worker.');

  const ended = events.find(
    (event): event is Extract<AgentSessionEvent, { type: 'tool_execution_end' }> =>
      event.type === 'tool_execution_end' && event.toolName === 'subagent',
  );

  const result = ended?.result as { details?: { labels?: Record<string, string> } } | undefined;

  expect(ended?.isError, JSON.stringify(result)).not.toBe(true);

  const assignmentPath = result?.details?.labels?.['tau.assignment'];

  expect(assignmentPath).toBeDefined();

  const assignment = JSON.parse(await readFile(assignmentPath ?? '', 'utf8')) as Assignment;
  const recorded = await readRecordedArguments(argvPath);

  const expected = workerArguments(
    assignment.session.file,
    assignment.loadout,
    assignment.extensionPackages ?? [],
    skillTools,
  );

  expect(expected).toContain(
    join(packageRoot, 'src', 'extensions', 'subagents', 'workerExtension.ts'),
  );

  expect(launchArguments(recorded, executable)).toEqual(expected);
}, 180_000);
