import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createCodemodeExtension } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import workerBashGuard from '../src/extensions/subagents/workerBashGuard.js';
import tddExtension from '../src/extensions/tdd/tdd.js';
import { createBoundSession } from './piSession.js';

interface BashValue {
  head: string;
  tail: string;
  length: number;
  truncated: boolean;
  exit_code: number;
}

// Returns what a codemode script receives from `tools.bash` in a session loaded like a worker's.
const scriptBash = async (command: string): Promise<BashValue> => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-bash-'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  const provider = fauxProvider({ provider: 'tau-worker-bash' });

  // A worker passes the guard with -e, so Pi loads it before the Tau package and its TDD hook.
  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: directory,
    providers: [provider],
    tools: ['bash', 'codemode'],
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    extensionFactories: [workerBashGuard, createCodemodeExtension({ mode: 'on' }), tddExtension],
  });

  const script = [
    `const result = await tools.bash({ command: ${JSON.stringify(command)} });`,
    'const { output, truncated, exit_code } = result;',
    'return { head: output.slice(0, 2000), tail: output.slice(-6000), length: output.length, truncated, exit_code };',
  ].join('\n');

  let scriptText: string | undefined;

  session.subscribe((event) => {
    if (event.type === 'tool_execution_end' && event.toolName === 'codemode') {
      scriptText = JSON.stringify(event.result);
    }
  });

  provider.setResponses([
    fauxAssistantMessage([fauxToolCall('codemode', { code: script })]),
    fauxAssistantMessage('Done.'),
  ]);

  await session.prompt('Run the command.');

  if (scriptText === undefined) {
    throw new Error('The script did not run.');
  }

  const result = JSON.parse(scriptText) as { content: { type: string; text?: string }[] };
  const value = result.content.findLast((block) => block.type === 'text')?.text ?? '';

  return JSON.parse(value) as BashValue;
};

const numbers = (count: number): string =>
  `${Array.from({ length: count }, (_, index) => index + 1).join('\n')}\n`;

it('gives scripts the full bash output when the worker cap trims the model text', async () => {
  const expected = numbers(1900);
  const value = await scriptBash('seq 1 1900');

  expect(value).toStrictEqual({
    head: expected.slice(0, 2000),
    tail: expected.slice(-6000),
    length: expected.length,
    truncated: false,
    exit_code: 0,
  });
});

it("gives scripts Pi's truncated bash output when Pi truncated it natively", async () => {
  const value = await scriptBash('seq 1 200000');

  expect(value.head).toMatch(/^1\n2\n3\n/u);
  expect(value.tail).toMatch(/\n199999\n200000\n$/u);
  expect(value.truncated).toBe(true);
  expect(value.exit_code).toBe(0);
});

it('gives scripts the output and exit code of a failing bash command', async () => {
  const value = await scriptBash('seq 1 1900; exit 3');

  expect(value).toMatchObject({ length: numbers(1900).length, truncated: false, exit_code: 3 });
});
