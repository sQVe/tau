import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { onTestFinished } from 'vitest';

import { createReceiptStore, createReceiver } from '../../../src/inbox/inbox.js';
import { decodeRequest, encodeFrame, refusedReply } from '../../../src/inbox/protocol.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { startHandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import type { HandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { contextOf, holdLock, recordSession, setup } from './fixtures/toolHarness.js';
import {
  askRecordDirectory,
  askRecordPath,
  readAskRecord,
  readAskRecords,
  writeAskRecord,
} from './record.js';
import type { HiddenAskRecord, LiveAskRecord } from './record.js';
import { createHeldLockToken, endArchitectSession } from './session.js';
import type { ArchitectSession } from './session.js';
import { createArchitectAnswerTool, createArchitectTool } from './tool.js';

type Cleanup = typeof onTestFinished;

interface CapturingInbox {
  path: string;
  frames: string[];
  saved: () => string[];
  releaseFirst: () => void;
}

const readdirSyncSafe = (path: string): string[] => {
  try {
    return readdirSync(path).map(String);
  } catch {
    return [];
  }
};

const leadLabel = (sessionId = 'session-lead'): string => `rpc1:/tmp/tau-lead/${sessionId}.sock`;

const replyTerminal = (hc: HcFake, address: string, label?: string): void => {
  const labels = label === undefined ? {} : { 'tau.inbox': label };

  hc.replyGet(address, JSON.stringify({ address, name: null, state: 'live', labels }));
};

const savedFiles = (receiver: HandoverReceiver): string[] =>
  receiver.savedRecords().filter((name) => name.endsWith('.json'));

const commands = (hc: HcFake): (string | undefined)[] =>
  hc.calls.map((call) => call.commandArguments[0]);

const getTargets = (hc: HcFake): (string | undefined)[] =>
  hc.calls
    .filter((call) => call.commandArguments[0] === 'get')
    .map((call) => call.commandArguments.at(-1));

const startCapturingInbox = async (
  cleanup: Cleanup,
  sessionId: string,
  first: 'suppress' | 'hold',
): Promise<CapturingInbox> => {
  const directory = join(temporaryDirectory(cleanup, 'tau-capturing-'), 'sockets');
  const records = join(directory, '..', 'records');
  const frames: string[] = [];
  let release: (() => void) | undefined;

  const receiver = createReceiver({
    directory: join(records, sessionId),
    terminal: 't-architect',
    sessionId,
    accepts: {
      handover: (_request, save) => save(),
      'architect-ask': (_request, save) => save(),
    },
    receipts: createReceiptStore(sessionId),
    entries: () => [],
    wake: () => true,
    notify: () => undefined,
  });

  mkdirSync(directory, { recursive: true });

  const path = join(directory, `${sessionId}.sock`);

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let data = '';

    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      data += chunk;
    });

    socket.on('end', () => {
      frames.push(data);

      if (frames.length === 1) {
        const finish = (): void => {
          socket.end();
        };

        if (first === 'hold') {
          release = finish;
        } else {
          finish();
        }

        return;
      }

      (async () => {
        const decision = decodeRequest(Buffer.from(data));

        const reply =
          decision.kind === 'frame'
            ? await receiver.accept(decision.value)
            : refusedReply(decision.reason);

        socket.end(encodeFrame(reply));
      })().catch(() => {
        socket.destroy();
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  cleanup(() => {
    server.close();
  });

  return {
    path,
    frames,
    saved: () => readdirSyncSafe(join(records, sessionId)).filter((name) => name.endsWith('.json')),
    releaseFirst: () => {
      release?.();
    },
  };
};

const liveArchitect = async (cleanup: Cleanup) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const sockets = temporaryDirectory(cleanup, 'tau-live-ask-');

  const receiver = await startHandoverReceiver(cleanup, sockets, 't-architect', {
    sessionId: 'session-architect',
    accepts: { 'architect-ask': (_request, save) => save() },
  });

  await recordSession(root, { terminal: 't-architect', sessionId: 'session-architect' });
  await holdLock(root, root);
  replyTerminal(hc, 't-lead', leadLabel());
  replyTerminal(hc, 't-architect', `rpc1:${receiver.path}`);

  return { root, hc, receiver, tool: createArchitectTool({ ...hc, cwd: root }) };
};

const liveRecord = (status: LiveAskRecord['status']): LiveAskRecord => ({
  version: 2,
  route: 'live',
  askId: randomUUID(),
  createdAt: '2026-11-18T10:00:00.000Z',
  question: 'Which flag name?',
  leadTerminal: 't-lead',
  leadSessionId: 'session-lead',
  architectTerminal: 't-architect',
  architectSessionId: 'session-architect',
  architectLockToken: 'live',
  status,
  detail: null,
  answer: null,
});

const hiddenRecord = (): HiddenAskRecord => ({
  version: 2,
  route: 'hidden',
  askId: randomUUID(),
  createdAt: '2026-11-18T10:00:00.000Z',
  question: 'Which flag name?',
  sessionFile: '/sessions/architect.jsonl',
  terminal: 't-ask',
  leadTerminal: 't-lead',
  deadline: 1900000000000,
  status: 'sent',
  detail: null,
  answer: null,
});

it('a live ask records the lead session and queues the question with the ask ID', async ({
  onTestFinished: cleanup,
}) => {
  const { root, hc, receiver, tool } = await liveArchitect(cleanup);

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  const { askId, note } = result.details as { askId: string; note: string };

  expect(result.details).toMatchObject({
    action: 'ask',
    status: 'queued',
    terminal: 't-architect',
  });

  expect(note).toContain(`Answer to ask ${askId}`);
  expect(savedFiles(receiver)).toEqual([`${receiver.sessionId}/${askId}.json`]);

  expect(await readAskRecord(root, askId)).toMatchObject({
    route: 'live',
    question: 'Which flag name?',
    leadTerminal: 't-lead',
    leadSessionId: 'session-lead',
    architectTerminal: 't-architect',
    architectSessionId: 'session-architect',
    architectLockToken: 'live',
    status: 'queued',
  });

  expect(commands(hc)).not.toContain('run');
});

it.for<[string, string | undefined]>([
  ['no inbox label', undefined],
  ['an inbox of another session', leadLabel('session-older')],
])(
  'a lead terminal with %s refuses the live ask before it writes or sends',
  async ([, label], { onTestFinished: cleanup }) => {
    const { root, hc, receiver, tool } = await liveArchitect(cleanup);

    replyTerminal(hc, 't-lead', label);

    const result = await tool.execute(
      'call',
      { action: 'ask', question: 'Which flag name?' },
      undefined,
      undefined,
      contextOf(root),
    );

    expect(result.details).toEqual({
      action: 'ask',
      status: 'needsOpen',
      reason:
        'This lead session has no working inbox, so the answer cannot reach it. Reload Pi, then ask again.',
    });

    await expect(readAskRecords(root)).resolves.toEqual({ records: [], gaps: [] });
    expect(receiver.savedRecords()).toEqual([]);
    expect(getTargets(hc)).toEqual(['t-lead']);
  },
);

it('a refused live ask marks its record failed', async ({ onTestFinished: cleanup }) => {
  const { root, hc, tool } = await liveArchitect(cleanup);

  replyTerminal(hc, 't-architect', leadLabel('session-newer'));

  await expect(
    tool.execute(
      'call',
      { action: 'ask', question: 'Which flag name?' },
      undefined,
      undefined,
      contextOf(root),
    ),
  ).rejects.toThrow(/changed session.*Nothing was queued/);

  const { records } = await readAskRecords(root);

  expect(records).toMatchObject([{ route: 'live', status: 'failed' }]);
  expect((records[0] as LiveAskRecord).detail).toMatch(/changed session/);
});

it('an unknown live ask retried with its ask ID resends the same bytes and saves once', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const inbox = await startCapturingInbox(cleanup, 'session-architect', 'suppress');

  await recordSession(root, { terminal: 't-architect', sessionId: 'session-architect' });
  await holdLock(root, root);
  replyTerminal(hc, 't-lead', leadLabel());
  replyTerminal(hc, 't-architect', `rpc1:${inbox.path}`);

  const tool = createArchitectTool({ ...hc, cwd: root });

  const asked = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  const { askId, note } = asked.details as { askId: string; note: string };

  expect(asked.details).toMatchObject({
    action: 'ask',
    status: 'unknown',
    terminal: 't-architect',
  });

  expect(note).toContain(`askId ${askId}`);
  expect(await readAskRecord(root, askId)).toMatchObject({ status: 'unknown' });

  const retried = await tool.execute(
    'call',
    { action: 'ask', askId },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(retried.details).toMatchObject({ action: 'ask', status: 'queued', askId });
  expect(inbox.frames).toHaveLength(2);
  expect(inbox.frames[1]).toBe(inbox.frames[0]);
  expect(JSON.parse(inbox.frames[0] ?? '{}')).toMatchObject({ messageId: askId });
  expect(JSON.parse(inbox.frames[1] ?? '{}')).toMatchObject({ messageId: askId });
  expect(inbox.saved()).toEqual([`${askId}.json`]);
  expect(await readAskRecord(root, askId)).toMatchObject({ status: 'queued' });
  expect(commands(hc)).not.toContain('run');
});

it.for<[string, string, RegExp]>([
  ['a missing record', 'missing', /No ask record/],
  ['a hidden record', 'hidden', /hidden ask/],
  ['a record of another lead session', 'other-lead', /lead session session-other/],
  ['a queued record', 'queued', /is queued/],
  ['an answered record', 'answered', /is answered/],
])(
  'an ask retry of %s throws its own error and sends nothing',
  async ([, kind, error], { onTestFinished: cleanup }) => {
    const { root, hc, receiver, tool } = await liveArchitect(cleanup);
    const askId = randomUUID();

    const records: Record<string, (HiddenAskRecord | LiveAskRecord) | undefined> = {
      missing: undefined,
      hidden: { ...hiddenRecord(), askId },
      'other-lead': { ...liveRecord('unknown'), askId, leadSessionId: 'session-other' },
      queued: { ...liveRecord('queued'), askId },
      answered: { ...liveRecord('answered'), askId },
    };

    const record = records[kind];

    if (record !== undefined) {
      await writeAskRecord(root, record);
    }

    await expect(
      tool.execute('call', { action: 'ask', askId }, undefined, undefined, contextOf(root)),
    ).rejects.toThrow(error);

    expect(await readAskRecord(root, askId)).toEqual(record);
    expect(receiver.savedRecords()).toEqual([]);
    expect(commands(hc)).toEqual([]);
  },
);

it('an ask retry refuses an ask ID that is not a UUID', async ({ onTestFinished: cleanup }) => {
  const { root, hc, tool } = await liveArchitect(cleanup);

  await expect(
    tool.execute(
      'call',
      { action: 'ask', askId: '../escape' },
      undefined,
      undefined,
      contextOf(root),
    ),
  ).rejects.toThrow('askId is not a UUID: ../escape');

  expect(commands(hc)).toEqual([]);
});

it('an ask retry refuses a question beside the ask ID', async ({ onTestFinished: cleanup }) => {
  const { root, hc, tool } = await liveArchitect(cleanup);

  await expect(
    tool.execute(
      'call',
      { action: 'ask', askId: randomUUID(), question: 'Which flag name?' },
      undefined,
      undefined,
      contextOf(root),
    ),
  ).rejects.toThrow('action ask with askId does not take question.');

  expect(commands(hc)).toEqual([]);
});

const startHeldQuestion = async (cleanup: Cleanup) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();

  const lead = await startHandoverReceiver(
    cleanup,
    temporaryDirectory(cleanup, 'tau-lead-inbox-'),
    't-lead',
    { sessionId: 'session-lead' },
  );

  const inbox = await startCapturingInbox(cleanup, 'session-architect', 'hold');

  await recordSession(root, { terminal: 't-architect', sessionId: 'session-architect' });
  await holdLock(root, root);
  replyTerminal(hc, 't-lead', `rpc1:${lead.path}`);
  replyTerminal(hc, 't-architect', `rpc1:${inbox.path}`);

  const tool = createArchitectTool({ ...hc, cwd: root });

  const asking = tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  await vi.waitFor(() => {
    expect(inbox.frames).toHaveLength(1);
  });

  const { records } = await readAskRecords(root);
  const record = records[0] as LiveAskRecord;

  expect(record.status).toBe('sending');

  return { root, hc, lead, inbox, asking, record };
};

it('an answer that lands before the lead send returns keeps the ask answered', async ({
  onTestFinished: cleanup,
}) => {
  const { root, hc, inbox, asking, record } = await startHeldQuestion(cleanup);

  await writeFile(join(root, 'answer.md'), 'Use --dry-run.\n');
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');

  const answered = await createArchitectAnswerTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'answer', askId: record.askId, file: 'answer.md' },
    undefined,
    undefined,
    contextOf(root, {}, 'session-architect'),
  );

  vi.stubEnv('HC_TERMINAL_ID', 't-lead');
  expect(answered.details).toEqual({ action: 'answer', status: 'queued', askId: record.askId });

  inbox.releaseFirst();
  await asking;

  expect(await readAskRecord(root, record.askId)).toMatchObject({ status: 'answered' });
});

it('a close that lands before the lead send returns keeps the ask failed', async ({
  onTestFinished: cleanup,
}) => {
  const { root, hc, lead, inbox, asking, record } = await startHeldQuestion(cleanup);
  const notify = vi.fn<(message: string, level?: string) => void>();

  const session: ArchitectSession = {
    root,
    release: () => Promise.resolve(),
    ui: { notify },
    owner: {
      lockToken: 'live',
      mode: 'visible',
      terminal: 't-architect',
      sessionId: 'session-architect',
    },
    held: createHeldLockToken(),
  };

  vi.stubEnv('HC_TERMINAL_ID', 't-architect');
  await endArchitectSession(session, { ...hc, cwd: root });
  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  expect(await readAskRecord(root, record.askId)).toMatchObject({ status: 'failed' });

  inbox.releaseFirst();
  await asking;

  expect(await readAskRecord(root, record.askId)).toMatchObject({ status: 'failed' });
  expect(lead.savedRecords().filter((name) => name.endsWith('.json'))).toHaveLength(1);
});

it.for([
  ['an askId that is not a UUID', 'not-a-uuid'],
  ['an askId that does not match its file name', '0190c1d2-0000-7000-8000-000000000701'],
])(
  'an ask retry of a record with %s throws and leaves the file unchanged',
  async ([, savedAskId], { onTestFinished: cleanup }) => {
    const { root, hc, receiver, tool } = await liveArchitect(cleanup);
    const askId = randomUUID();
    const path = askRecordPath(root, askId);
    const saved = JSON.stringify({ ...liveRecord('unknown'), askId: savedAskId });

    mkdirSync(askRecordDirectory(root), { recursive: true });
    await writeFile(path, saved);

    await expect(
      tool.execute('call', { action: 'ask', askId }, undefined, undefined, contextOf(root)),
    ).rejects.toThrow(`Malformed ask record ${path}`);

    await expect(readFile(path, 'utf8')).resolves.toBe(saved);
    expect(receiver.savedRecords()).toEqual([]);
    expect(commands(hc)).toEqual([]);
  },
);
