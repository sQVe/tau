import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { terminalTypingReason } from '../src/extensions/inbox/guard.js';
import { workerArguments } from '../src/extensions/subagents/workerCommand.js';
import { skillTools } from '../src/skillTools.js';
import tauExtension from '../src/tau.js';
import { installHcCommand } from './hcCommandHarness.js';
import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';
import { createBoundSession } from './piSession.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

const tauEntry = join(packageRoot, 'src', 'tau.ts');

const workerExtensionPaths = (directory: string): string[] => {
  const commandLine = workerArguments(
    join(directory, 'worker.jsonl'),
    {
      harness: 'pi',
      profile: 'worker',
      role: 'editing',
      model: 'faux/test',
      thinking: 'off',
      cwd: directory,
      agentDirectory: directory,
      permissions: 'trusted-full-tools',
      instructions: 'Work on the assigned task.',
      tools: ['bash'],
      skills: [],
      instructionSets: [],
      packages: [],
    },
    [{ path: packageRoot }],
    skillTools,
  );

  return commandLine.flatMap((word, index) => (commandLine[index - 1] === '-e' ? [word] : []));
};

// Resolves extension sources the way Pi does for `-e`, without importing any extension.
const resolvedExtensions = async (sources: string[]): Promise<string[]> => {
  const directory = temporaryDirectory(onTestFinished, 'tau-inbox-guard-');

  const packageManager = new DefaultPackageManager({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
  });

  const { extensions } = await packageManager.resolveExtensionSources(sources, {
    temporary: true,
  });

  return extensions.filter(({ enabled }) => enabled).map(({ path }) => path);
};

// Each test loads Tau as a factory into its own session. Loading the package path instead makes
// Pi transform every Tau module again, which takes seconds. The path test below covers that a
// manager and a worker load this same entry point.
const bashResult = async (command: string) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-inbox-guard-');
  const { bin, log } = installHcCommand(directory);

  isolateWebAccessConfig(directory, onTestFinished);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  vi.stubEnv('HC_FAKE_LOG', log);
  vi.stubEnv('HC_SESSION', 'tau-test-inbox-guard');
  vi.stubEnv('HC_TERMINAL_ID', undefined);

  const provider = fauxProvider({ provider: 'tau-inbox-guard' });

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [provider],
    tools: ['bash'],
    extensionFactories: [tauExtension],
  });

  const results: { isError: boolean; text: string }[] = [];

  session.subscribe((event) => {
    if (event.type === 'tool_execution_end' && event.toolName === 'bash') {
      results.push({ isError: event.isError, text: JSON.stringify(event.result) });
    }
  });

  provider.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command })]),
    fauxAssistantMessage('Done.'),
  ]);

  await session.prompt('Run the command.');

  const hcLog = existsSync(log) ? readFileSync(log, 'utf8') : '';

  return { results, hcLog };
};

const typedSendResult = () => bashResult('cd . && hc keys t1 enter');

const reasonText = JSON.stringify(terminalTypingReason).slice(1, -1);

const refusalOf = ({ results, hcLog }: Awaited<ReturnType<typeof bashResult>>) => ({
  results: results.map(({ isError, text }) => ({ isError, refused: text.includes(reasonText) })),
  typed: hcLog.includes('keys'),
});

const refused = { results: [{ isError: true, refused: true }], typed: false };

it('loads Tau from the package path and from the worker command line', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-inbox-guard-');

  expect(await resolvedExtensions([packageRoot])).toContain(tauEntry);
  expect(await resolvedExtensions(workerExtensionPaths(directory))).toContain(tauEntry);
});

it('refuses a typed send in a manager session that loads Tau', async () => {
  expect(refusalOf(await typedSendResult())).toEqual(refused);
});

it('refuses a typed send in a worker session that loads Tau', async () => {
  vi.stubEnv('TAU_ROLE', 'worker');

  expect(refusalOf(await typedSendResult())).toEqual(refused);
});

it('lets other hc commands run in a session that loads Tau', async () => {
  const { results, hcLog } = await bashResult('hc get t1');

  expect(results.map(({ text }) => text.includes(reasonText))).toEqual([false]);
  expect(hcLog).toBe('get t1\n');
});
