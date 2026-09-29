import { readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createBashTool } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import workerBashGuard from './workerBashGuard.js';

interface ModelResult {
  content: { type: string; text: string }[];
  isError: boolean;
}

// Runs Pi's real bash tool and shapes its result as Pi does for tool_result handlers.
const runBash = async (command: string): Promise<ModelResult> => {
  try {
    const result = await createBashTool(import.meta.dirname).execute('call', { command });

    return { content: result.content as ModelResult['content'], isError: false };
  } catch (error) {
    return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
  }
};

const modelText = async (result: ModelResult): Promise<string> => {
  const fake = fakeExtensionApi();
  workerBashGuard(fake.pi);

  const handler = fake.handler('tool_result');
  const event = { type: 'tool_result', toolName: 'bash', toolCallId: 'call', input: {}, ...result };
  const replaced = (await handler(event, {} as never)) as ModelResult | undefined;

  return (replaced ?? result).content.map((part) => part.text).join('');
};

const savedPath = (text: string): string => {
  const path = /Full output: (\S+)\]/u.exec(text)?.[1];

  if (path === undefined) {
    throw new Error(`No saved output path in: ${text.slice(0, 200)}`);
  }

  onTestFinished(() => rm(dirname(path), { recursive: true, force: true }));

  return path;
};

it('leaves output under the cap unchanged', async () => {
  const result = await runBash('seq 1 1000');

  expect(await modelText(result)).toBe(result.content[0]?.text);
});

it('shows the head and tail of long output and saves the exact output privately', async () => {
  const result = await runBash('seq 1 1900');
  const text = await modelText(result);
  const path = savedPath(text);

  expect(text.length).toBeLessThanOrEqual(8000);
  expect(text).toMatch(/^1\n2\n3\n/u);
  expect(text).toMatch(/1899\n1900\n?$/u);
  expect(text).toMatch(/\[\d+ of 8393 characters cut\. Command exited with code 0\./u);
  expect(await readFile(path, 'utf8')).toBe(result.content[0]?.text);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
});

it('leaves the output of a long failing command whole', async () => {
  const result = await runBash('seq 1 1200; echo "error: a test failed" >&2; seq 1 1200; exit 3');

  expect(result.isError).toBe(true);
  expect(await modelText(result)).toBe(result.content[0]?.text);
});

it("keeps the path to Pi's full output when Pi truncated first", async () => {
  const result = await runBash('seq 1 5000');
  const text = await modelText(result);
  savedPath(text);

  expect(text).toMatch(/\[Showing lines 3001-5000 of 5000\. Full output: \S+pi-bash\S+\.log\]$/u);
});

it('caps binary output and saves the text Pi decoded', async () => {
  const result = await runBash(
    String.raw`for i in $(seq 1 3000); do printf 'a\377\000\351b\n'; done`,
  );

  const text = await modelText(result);

  expect(text.length).toBeLessThanOrEqual(8000);
  expect(await readFile(savedPath(text), 'utf8')).toBe(result.content[0]?.text);
});
