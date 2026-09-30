import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { FauxResponseStep } from '@earendil-works/pi-ai';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';
import { expect, it, vi } from 'vitest';

import compactionExtension from '../src/extensions/compaction/index.js';
import { createBoundSession } from './piSession.js';

// Real Pi sessions need extra time on slow CI.
vi.setConfig({ testTimeout: 60_000 });

const isSummaryRequest = (context: unknown) =>
  JSON.stringify(context).includes('context summarization assistant');

// Each prompt is about 25k tokens, so the second run's tool turn has an older part to summarize.
const oldPrompt = `old-marker ${'a'.repeat(100_000)}`;
const recentPrompt = `recent-marker ${'b'.repeat(100_000)}`;

const createHarness = async (
  registerCleanup: TestContext['onTestFinished'],
  summary: FauxResponseStep,
) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-compaction-flow-'));

  registerCleanup(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_WORKER_RECORD', '');
  await writeFile(join(directory, 'tau.json'), '{"compaction":{"thresholdTokens":40000}}');
  await writeFile(join(directory, 'notes.txt'), 'Notes.');

  const faux = fauxProvider({ provider: 'tau-compaction-test' });

  const answers = [
    fauxAssistantMessage('First answer.'),
    fauxAssistantMessage(fauxToolCall('read', { path: 'notes.txt' })),
    fauxAssistantMessage('Done.'),
  ];

  const requests: string[] = [];

  const respond: FauxResponseStep = (context, options, state, model) => {
    if (isSummaryRequest(context)) {
      return typeof summary === 'function' ? summary(context, options, state, model) : summary;
    }

    requests.push(JSON.stringify(context.messages));

    return answers.shift() ?? fauxAssistantMessage('Unexpected request.');
  };

  faux.setResponses([respond, respond, respond, respond]);
  const statuses: (string | undefined)[] = [];

  // Pi calls other UI methods too; they do nothing here.
  const recordingUI: Record<string | symbol, unknown> = {
    setStatus: (_key: string, text: string | undefined) => statuses.push(text),
  };

  const uiContext = new Proxy(recordingUI, {
    get: (target, property) => target[property] ?? (() => undefined),
  }) as unknown as ExtensionUIContext;

  const { session } = await createBoundSession(
    registerCleanup,
    {
      cwd: directory,
      agentDirectory: directory,
      providers: [faux],
      tools: ['read'],
      extensionFactories: [
        (pi) => {
          compactionExtension(pi, async () => ({ text: '## Ledger', details: { version: 1 } }));
        },
      ],
    },
    { uiContext },
  );

  return { session, requests, statuses };
};

it('compacts between turns of one run and continues with the summary', async ({
  onTestFinished,
}) => {
  const summaryRequests: string[] = [];

  const { session, requests, statuses } = await createHarness(onTestFinished, (context) => {
    summaryRequests.push(JSON.stringify(context.messages));

    return fauxAssistantMessage('Model summary text.');
  });

  await session.prompt(oldPrompt);
  await session.prompt(recentPrompt);

  const entries = session.sessionManager.getBranch();
  const compactions = entries.filter((entry) => entry.type === 'compaction');

  const recentUser = entries.find(
    (entry) => entry.type === 'message' && JSON.stringify(entry.message).includes('recent-marker'),
  );

  expect(compactions).toHaveLength(1);
  expect(compactions[0]).toMatchObject({ firstKeptEntryId: recentUser?.id });
  expect(summaryRequests).toHaveLength(1);
  expect(summaryRequests[0]).toContain('old-marker');
  expect(summaryRequests[0]).not.toContain('recent-marker');

  // The request after the tool result belongs to the same run and already sees the summary.
  expect(requests).toHaveLength(3);
  expect(requests[2]).toContain('Model summary text.');
  expect(requests[2]).not.toContain('old-marker');
  expect(requests[2]).toContain('recent-marker');
  expect(entries.at(-1)).toMatchObject({ type: 'message', message: { stopReason: 'stop' } });
  expect(statuses.length).toBeGreaterThan(1);
  expect(statuses.at(-1)).toBeUndefined();
});

it('saves no compaction and clears the status when the user aborts during the summary', async ({
  onTestFinished,
}) => {
  const { promise: summaryRequested, resolve: summaryStarted } = Promise.withResolvers<undefined>();

  const { session, statuses } = await createHarness(onTestFinished, async (_context, options) => {
    summaryStarted(undefined);

    await new Promise((resolve) =>
      options?.signal?.addEventListener('abort', resolve, { once: true }),
    );

    return fauxAssistantMessage('Late summary.');
  });

  await session.prompt(oldPrompt);
  const running = session.prompt(recentPrompt);
  await summaryRequested;
  await session.abort();
  await running;

  const entries = session.sessionManager.getBranch();

  expect(entries.filter((entry) => entry.type === 'compaction')).toEqual([]);
  expect(statuses.at(-1)).toBeUndefined();
  expect(session.isStreaming).toBe(false);
});
