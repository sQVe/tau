import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { FauxResponseStep } from '@earendil-works/pi-ai';
import type {
  BoundaryResult,
  ExtensionContext,
  ProjectedSessionEntry,
} from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import type { WorkerLedgerReader } from './boundary.js';
import compactionExtension from './index.js';

const projected = (id: string, role: 'user' | 'assistant', text: string) =>
  ({
    sourceEntry: { type: 'message', id, parentId: null, timestamp: '' },
    messages:
      role === 'user'
        ? [{ role, content: text, timestamp: 1 }]
        : [
            {
              ...fauxAssistantMessage(text),
              api: 'faux',
              provider: 'faux',
              model: 'faux-1',
            },
          ],
  }) as unknown as ProjectedSessionEntry;

// About 25k tokens each, so the recent tail starts at the second user message.
const contextEntries = [
  projected('old-user', 'user', `old-marker ${'a'.repeat(100_000)}`),
  projected('old-answer', 'assistant', 'Old answer.'),
  projected('recent-user', 'user', `recent-marker ${'b'.repeat(100_000)}`),
  projected('recent-answer', 'assistant', 'Recent answer.'),
];

const boundaryEvent = (overrides: Record<string, unknown> = {}) => ({
  type: 'turn_end',
  outcome: 'completed',
  entries: [],
  continue: false,
  context: { contextEntries },
  ...overrides,
});

const ledger = { text: '## Ledger task-7', details: { version: 1, workers: [] } };

const setup = (
  options: {
    tokens?: number | null | undefined;
    config?: unknown;
    readWorkerLedger?: WorkerLedgerReader;
  } = {},
) => {
  const agentDirectory = mkdtempSync(join(tmpdir(), 'tau-compaction-'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(agentDirectory, { recursive: true, force: true });
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('TAU_WORKER_RECORD', '');

  if (options.config !== undefined) {
    writeFileSync(join(agentDirectory, 'tau.json'), JSON.stringify(options.config));
  }

  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1' }] });
  const statuses: (string | undefined)[] = [];
  const notices: string[] = [];
  const run = new AbortController();
  const api = fakeExtensionApi();
  const usage = { tokens: options.tokens === undefined ? 250_000 : options.tokens };
  compactionExtension(api.pi, options.readWorkerLedger ?? (async () => ledger));

  const context = {
    cwd: agentDirectory,
    isProjectTrusted: () => false,
    signal: run.signal,
    model: faux.getModel(),
    thinkingLevel: 'off',
    getContextUsage: () => ({
      tokens: usage.tokens,
      contextWindow: 1_000_000,
    }),
    modelRegistry: { streamSimple: faux.provider.streamSimple.bind(faux.provider) },
    sessionManager: { getSessionFile: () => undefined },
    ui: {
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      notify: (message: string) => notices.push(message),
    },
  } as unknown as ExtensionContext;

  const boundary = (event = boundaryEvent()) =>
    api.handler('turn_end')(event, context) as Promise<BoundaryResult | undefined>;

  return { api, faux, statuses, notices, run, context, boundary, usage };
};

// Resolves when the summary request starts; the request then waits for its abort signal.
const heldSummary = () => {
  const { promise: requested, resolve: started } = Promise.withResolvers<AbortSignal>();

  const response: FauxResponseStep = async (_context, options) => {
    const signal = options?.signal ?? new AbortController().signal;
    started(signal);

    await new Promise((resolve) => {
      signal.addEventListener('abort', resolve, { once: true });
    });

    return fauxAssistantMessage('Late summary.');
  };

  return { requested, response };
};

it('registers no handlers in a worker process', () => {
  vi.stubEnv('TAU_WORKER_RECORD', '/tmp/task');
  const api = fakeExtensionApi();

  compactionExtension(api.pi, async () => ledger);

  expect(api.handlers.size).toBe(0);
});

it('appends a compaction draft that keeps the recent tail and summarizes the rest', async () => {
  const fixture = setup();
  const requests: string[] = [];

  fixture.faux.setResponses([
    (request) => {
      requests.push(JSON.stringify(request.messages));

      return fauxAssistantMessage('Model summary text.');
    },
  ]);

  const existing = { type: 'custom', customType: 'other-extension' };
  const result = await fixture.boundary(boundaryEvent({ entries: [existing] }));

  expect(result?.entries).toEqual([
    existing,
    expect.objectContaining({
      type: 'compaction',
      firstKeptEntryId: 'recent-user',
      details: ledger.details,
    }),
  ]);

  const draft = result?.entries?.[1] as { summary: string; usage?: unknown };

  expect(draft.summary.startsWith(ledger.text)).toBe(true);
  expect(draft.summary).toContain('Model summary text.');
  expect(draft.usage).toBeDefined();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain('old-marker');
  expect(requests[0]).not.toContain('recent-marker');
  expect(fixture.statuses.at(-1)).toBeUndefined();
  expect(fixture.statuses.length).toBeGreaterThan(1);
});

it('uses the same boundary when a run settles above the threshold', async () => {
  const fixture = setup();
  fixture.faux.setResponses([fauxAssistantMessage('Model summary text.')]);

  const result = (await fixture.api.handler('agent_before_settle')(
    boundaryEvent({ type: 'agent_before_settle' }),
    fixture.context,
  )) as BoundaryResult | undefined;

  expect(result?.entries).toEqual([expect.objectContaining({ type: 'compaction' })]);
});

it.each([
  { name: 'the context is at the threshold', tokens: 200_000, event: boundaryEvent() },
  { name: 'Pi cannot count the context', tokens: null, event: boundaryEvent() },
  { name: 'the turn was aborted', event: boundaryEvent({ outcome: 'aborted' }) },
  {
    name: 'a compaction draft is pending',
    event: boundaryEvent({
      entries: [{ type: 'compaction', summary: 'x', firstKeptEntryId: null }],
    }),
  },
  {
    name: 'the whole context fits in the recent tail',
    event: boundaryEvent({ context: { contextEntries: contextEntries.slice(2) } }),
  },
])('returns no draft and calls no model when $name', async ({ tokens, event }) => {
  const fixture = setup({ tokens });

  await expect(fixture.boundary(event)).resolves.toBeUndefined();

  expect(fixture.faux.state.callCount).toBe(0);
  expect(fixture.statuses).toEqual([]);
});

it('reads the threshold from Tau config', async () => {
  const fixture = setup({ tokens: 120_000, config: { compaction: { thresholdTokens: 100_000 } } });
  fixture.faux.setResponses([fauxAssistantMessage('Model summary text.')]);

  const result = await fixture.boundary();

  expect(result?.entries).toEqual([expect.objectContaining({ type: 'compaction' })]);
});

it('returns no draft, warns, and clears the status when the summary fails', async () => {
  const fixture = setup();

  fixture.faux.setResponses([
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'provider down' }),
  ]);

  await expect(fixture.boundary()).resolves.toBeUndefined();

  expect(fixture.notices.join('\n')).toContain('provider down');
  expect(fixture.statuses.at(-1)).toBeUndefined();
});

it('waits for the kept-tail size of new context before it retries a failed summary', async () => {
  const fixture = setup();

  fixture.faux.setResponses([
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'provider down' }),
    fauxAssistantMessage('Model summary text.'),
  ]);

  await fixture.boundary();
  fixture.usage.tokens = 269_999;

  await expect(fixture.boundary()).resolves.toBeUndefined();
  expect(fixture.faux.state.callCount).toBe(1);

  fixture.usage.tokens = 270_000;
  const retried = await fixture.boundary();

  expect(retried?.entries).toEqual([expect.objectContaining({ type: 'compaction' })]);
});

it('retries a failed summary in a new session without waiting', async () => {
  const fixture = setup();

  fixture.faux.setResponses([
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'provider down' }),
    fauxAssistantMessage('Model summary text.'),
  ]);

  await fixture.boundary();

  await fixture.api.handler('session_start')(
    { type: 'session_start', reason: 'new' },
    fixture.context,
  );

  const retried = await fixture.boundary();

  expect(retried?.entries).toEqual([expect.objectContaining({ type: 'compaction' })]);
});

it('does not wait after an aborted summary', async () => {
  const fixture = setup();
  const summary = heldSummary();
  fixture.faux.setResponses([summary.response, fauxAssistantMessage('Model summary text.')]);

  const pending = fixture.boundary();
  const requestSignal = await summary.requested;

  await fixture.api.handler('session_shutdown')(
    { type: 'session_shutdown', reason: 'quit' },
    fixture.context,
  );

  await pending;

  expect(requestSignal.aborted).toBe(true);

  expect((await fixture.boundary())?.entries).toEqual([
    expect.objectContaining({ type: 'compaction' }),
  ]);
});

it('returns no draft and calls no model when the worker ledger cannot be read', async () => {
  const fixture = setup({
    readWorkerLedger: () => Promise.reject(new Error('Session ancestry is unavailable')),
  });

  await expect(fixture.boundary()).resolves.toBeUndefined();

  expect(fixture.notices.join('\n')).toContain('Session ancestry is unavailable');
  expect(fixture.faux.state.callCount).toBe(0);
  expect(fixture.statuses.at(-1)).toBeUndefined();
});

it('returns no draft and warns when Tau config is invalid', async () => {
  const fixture = setup({ config: { compaction: { thresholdTokens: -1 } } });

  await expect(fixture.boundary()).resolves.toBeUndefined();

  expect(fixture.notices.join('\n')).toContain('tau.json');
  expect(fixture.faux.state.callCount).toBe(0);
});

it('returns no draft and clears the status when the run aborts during the summary', async () => {
  const fixture = setup();
  const summary = heldSummary();
  fixture.faux.setResponses([summary.response]);

  const pending = fixture.boundary();
  await summary.requested;
  fixture.run.abort();

  await expect(pending).resolves.toBeUndefined();

  expect(fixture.notices).toEqual([]);
  expect(fixture.statuses.at(-1)).toBeUndefined();
});

it('stops the summary and clears the status when the session shuts down', async () => {
  const fixture = setup();
  const summary = heldSummary();
  fixture.faux.setResponses([summary.response]);

  const pending = fixture.boundary();
  const requestSignal = await summary.requested;

  await fixture.api.handler('session_shutdown')(
    { type: 'session_shutdown', reason: 'quit' },
    fixture.context,
  );

  expect(requestSignal.aborted).toBe(true);
  expect(fixture.statuses.at(-1)).toBeUndefined();
  await expect(pending).resolves.toBeUndefined();
  expect(fixture.notices).toEqual([]);
});
