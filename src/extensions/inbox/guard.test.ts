import { existsSync, readFileSync } from 'node:fs';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it, onTestFinished, vi } from 'vitest';

import { installHcCommand } from '../../../tests/hcCommandHarness.js';
import { createBoundSession } from '../../../tests/piSession.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { terminalTypingReason } from './guard.js';
import inboxExtension from './inbox.js';

// Tool results hold the reason as JSON text.
const reasonText = JSON.stringify(terminalTypingReason).slice(1, -1);

// Runs the given tool calls in a session that loads only the inbox extension, outside a terminal.
const runToolCalls = async (calls: ReturnType<typeof fauxToolCall>[]) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-inbox-guard-');
  const { bin, log } = installHcCommand(directory);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  vi.stubEnv('HC_FAKE_LOG', log);
  vi.stubEnv('HC_SESSION', 'tau-test-inbox-guard');
  vi.stubEnv('HC_TERMINAL_ID', undefined);
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  const provider = fauxProvider({ provider: 'tau-inbox-guard' });

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [provider],
    tools: ['bash', 'read'],
    extensionFactories: [inboxExtension],
  });

  const results: { isError: boolean; text: string }[] = [];

  session.subscribe((event) => {
    if (event.type === 'tool_execution_end') {
      results.push({ isError: event.isError, text: JSON.stringify(event.result) });
    }
  });

  provider.setResponses([fauxAssistantMessage(calls), fauxAssistantMessage('Done.')]);

  await session.prompt('Run the calls.');

  const hcLog = existsSync(log) ? readFileSync(log, 'utf8') : '';

  return { results, hcLog };
};

it('refuses a typed send before bash runs, even without a terminal', async () => {
  const { results, hcLog } = await runToolCalls([
    fauxToolCall('bash', { command: 'hc send t1 hello' }),
  ]);

  expect(results).toHaveLength(1);
  expect(results[0]?.isError).toBe(true);
  expect(results[0]?.text).toContain(reasonText);
  expect(hcLog).toBe('');
});

it('lets other hc commands and other tools run', async () => {
  const { results, hcLog } = await runToolCalls([
    fauxToolCall('bash', { command: 'hc get t1' }),
    fauxToolCall('read', { path: 'missing.txt' }),
  ]);

  expect(results.map(({ text }) => text.includes(reasonText))).toEqual([false, false]);
  expect(hcLog).toBe('get t1\n');
});
