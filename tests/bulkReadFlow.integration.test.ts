import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished as registerTestCleanup, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { createBoundSession } from './piSession.js';

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllEnvs();
});

const createHarness = async (registerCleanup: TestContext['onTestFinished']) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-bulk-flow-'));
  registerCleanup(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, 'agent');
  await mkdir(agentDir);

  await writeFile(
    join(agentDir, 'tau.json'),
    JSON.stringify({ bulkRead: { model: 'tau-bulk/reader' } }),
  );

  // Tau reads its user config from the agent directory Pi names in the environment.
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  const content = Array.from({ length: 450 }, (_, index) => `line ${index + 1}`).join('\n');
  await writeFile(join(cwd, 'large.txt'), content);

  const sessionModel = fauxProvider({ provider: 'tau-test' });
  const reader = fauxProvider({ provider: 'tau-bulk', models: [{ id: 'reader' }] });

  const { session } = await createBoundSession(registerCleanup, {
    cwd,
    agentDirectory: agentDir,
    providers: [sessionModel, reader],
    tools: ['read', 'bulk_read'],
    extensionPaths: [resolve(import.meta.dirname, '../src/extensions/bulkRead/bulkRead.ts')],
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
  });

  return { session, sessionModel, reader, content, cwd };
};

const toolResult = (session: AgentSession, name: string) => {
  const entry = session.sessionManager
    .getEntries()
    .find(
      (candidate) =>
        candidate.type === 'message' &&
        candidate.message.role === 'toolResult' &&
        candidate.message.toolName === name,
    );

  if (entry?.type !== 'message' || entry.message.role !== 'toolResult') {
    throw new Error(`Missing result for ${name}`);
  }

  return entry.message;
};

const textOf = (content: { type: string; text?: string }[]) =>
  content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');

it('clamps a real Pi read and records bulk_read model usage in the session ledger', async ({
  onTestFinished,
}) => {
  const { session, sessionModel, reader } = await createHarness(onTestFinished);
  let sessionPrompt = '';

  sessionModel.setResponses([
    (context) => {
      sessionPrompt = getCurrentSystemPrompt(context.messages);

      return fauxAssistantMessage([fauxToolCall('read', { path: 'large.txt' })]);
    },
    fauxAssistantMessage([
      fauxToolCall('bulk_read', { paths: ['large.txt'], question: 'What does this file contain?' }),
    ]),
    fauxAssistantMessage('Done.'),
  ]);

  reader.setResponses([fauxAssistantMessage('- large.txt:450 ends with line 450.')]);

  await session.prompt('Explain the large file.');

  expect(sessionPrompt).toContain('Use bulk_read summaries for navigation without rereading');
  expect(sessionPrompt).toContain('Verify only consequential claims');
  expect(sessionPrompt).toContain('Integration claims need production callers');
  expect(sessionPrompt).toContain('actual diff and applicable project rules');

  const read = textOf(toolResult(session, 'read').content);
  expect(read).toMatch(/Lines 401-450 remain\. Read with offset=401 and limit=50 to continue\.$/);
  expect(read).not.toContain('bulk_read');
  expect(read).not.toMatch(/^line 401$/m);
  const bulk = toolResult(session, 'bulk_read');
  expect(bulk.usage?.input).toBeGreaterThan(0);
  expect(textOf(bulk.content)).toBe('- large.txt:450 ends with line 450.');
  expect(reader.state.callCount).toBe(1);
  expect(sessionModel.state.callCount).toBe(3);
});

it.each([400, 401])(
  'rewrites a real byte-truncated read with %i remaining lines and preserves bounded continuation',
  async (remaining) => {
    const { session, sessionModel, reader, cwd } = await createHarness(registerTestCleanup);
    const head = Array.from({ length: 50 }, () => 'x'.repeat(1023)).join('\n');
    const tail = Array.from({ length: remaining }, (_, index) => `line ${index + 51}`).join('\n');
    await writeFile(join(cwd, 'byte-limited.txt'), `${head}\n${tail}`);

    sessionModel.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'byte-limited.txt' })]),
      fauxAssistantMessage([
        fauxToolCall('read', { path: 'byte-limited.txt', offset: 51, limit: remaining }),
      ]),
      fauxAssistantMessage('Done.'),
    ]);

    await session.prompt('Read the file, then read the remaining lines with an explicit limit.');

    const reads = session.sessionManager
      .getEntries()
      .flatMap((entry) =>
        entry.type === 'message' &&
        entry.message.role === 'toolResult' &&
        entry.message.toolName === 'read'
          ? [entry.message]
          : [],
      );

    expect(reads).toHaveLength(2);

    expect(reads[0]!.details).toMatchObject({
      truncation: {
        truncated: true,
        truncatedBy: 'bytes',
        totalLines: 400,
        outputLines: 50,
        outputBytes: 51_199,
        maxBytes: 51_200,
      },
    });

    const guidance =
      remaining > 400
        ? 'For questions, call bulk_read with paths and question. To edit, use a bounded read with offset and limit.'
        : 'Read with offset=51 and limit=400 to continue.';

    expect(textOf(reads[0]!.content)).toBe(
      `${head}\n\nLines 51-${50 + remaining} remain. ${guidance}`,
    );

    expect(textOf(reads[0]!.content).includes('bulk_read')).toBe(remaining > 400);
    expect(reads.every((read) => !read.isError)).toBe(true);
    expect(textOf(reads[1]!.content)).toBe(tail);
    expect(reader.state.callCount).toBe(0);
  },
);
