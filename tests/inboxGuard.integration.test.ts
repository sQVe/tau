import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it, onTestFinished, vi } from 'vitest';

import { terminalTypingReason } from '../src/extensions/inbox/guard.js';
import { workerArguments } from '../src/extensions/subagents/workerCommand.js';
import { skillTools } from '../src/skillTools.js';
import { installHcCommand } from './hcCommandHarness.js';
import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';
import { createBoundSession } from './piSession.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

// The extension paths a worker's Pi command line loads, in order, with Tau as its package.
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

// Runs one bash call in a session that loads the given extensions, and returns the tool result.
const typedSendResult = async (extensionPaths: (directory: string) => string[]) => {
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
    extensionPaths: extensionPaths(directory),
  });

  const results: { isError: boolean; text: string }[] = [];

  session.subscribe((event) => {
    if (event.type === 'tool_execution_end' && event.toolName === 'bash') {
      results.push({ isError: event.isError, text: JSON.stringify(event.result) });
    }
  });

  provider.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'cd . && hc keys t1 enter' })]),
    fauxAssistantMessage('Done.'),
  ]);

  await session.prompt('Press enter in t1.');

  const typed = existsSync(log) && readFileSync(log, 'utf8').includes('keys');

  return { results, typed };
};

// Tool results hold the reason as JSON text.
const reasonText = JSON.stringify(terminalTypingReason).slice(1, -1);

const refusalOf = ({ results, typed }: Awaited<ReturnType<typeof typedSendResult>>) => ({
  results: results.map(({ isError, text }) => ({ isError, refused: text.includes(reasonText) })),
  typed,
});

const refused = { results: [{ isError: true, refused: true }], typed: false };

it('refuses a typed send in a manager session that loads the Tau package', async () => {
  expect(refusalOf(await typedSendResult(() => [packageRoot]))).toEqual(refused);
});

it('refuses a typed send in a worker session loaded like a worker command line', async () => {
  vi.stubEnv('TAU_ROLE', 'worker');

  expect(refusalOf(await typedSendResult(workerExtensionPaths))).toEqual(refused);
});
