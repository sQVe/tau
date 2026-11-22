import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { onTestFinished } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import type { HandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import { createAnswerTracker } from './answer.js';
import { createAskAdmissions } from './ask/askAcceptance.js';
import { startCapturingInbox } from './fixtures/capturingInbox.js';
import { startLeadInbox } from './fixtures/leadInbox.js';
import { startLiveArchitect } from './fixtures/liveArchitect.js';
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

const liveArchitect = (cleanup: Cleanup, withLeadInbox = true) =>
  startLiveArchitect(cleanup, { withLeadInbox });

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

it('a lead label that names this session without a local listener refuses the live ask', async ({
  onTestFinished: cleanup,
}) => {
  const { root, hc, receiver, tool } = await liveArchitect(cleanup, false);

  replyTerminal(hc, 't-lead', leadLabel());

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
});

it.for<{ reply: string }>([
  {
    reply: JSON.stringify({ address: 't-architect', name: null, state: 'live', labels: {} }),
  },
  { reply: JSON.stringify({ address: 't-architect', name: null, state: 'live' }) },
])(
  'a live ask to an architect terminal without an inbox label saves no record and sends nothing',
  async ({ reply }, { onTestFinished: cleanup }) => {
    const { root, hc, receiver, tool } = await liveArchitect(cleanup);

    hc.replyGet('t-architect', reply);

    const result = await tool.execute(
      'call',
      { action: 'ask', question: 'Which flag name?' },
      undefined,
      undefined,
      contextOf(root),
    );

    expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });

    expect((result.details as { reason: string }).reason).toContain(
      't-architect advertises no Tau inbox',
    );

    await expect(readAskRecords(root)).resolves.toEqual({ records: [], gaps: [] });
    expect(savedFiles(receiver)).toEqual([]);
  },
);

it('a live ask asked again after the architect inbox returns queues one ask', async ({
  onTestFinished: cleanup,
}) => {
  const { root, hc, receiver, tool } = await liveArchitect(cleanup);

  replyTerminal(hc, 't-architect');

  const refused = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(refused.details).toMatchObject({ action: 'ask', status: 'needsOpen' });

  replyTerminal(hc, 't-architect', `rpc1:${receiver.path}`);

  const asked = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  const { askId } = asked.details as { askId: string };

  expect(asked.details).toMatchObject({ action: 'ask', status: 'queued', askId });

  const { records } = await readAskRecords(root);

  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ askId });
  expect(savedFiles(receiver)).toEqual([`${receiver.sessionId}/${askId}.json`]);
});

it("a live ask to a finished architect terminal keeps the sender's refusal", async ({
  onTestFinished: cleanup,
}) => {
  const { root, hc, tool } = await liveArchitect(cleanup);

  hc.replyGet(
    't-architect',
    JSON.stringify({ address: 't-architect', name: null, state: 'finished', labels: {} }),
  );

  const failure = await tool
    .execute(
      'call',
      { action: 'ask', question: 'Which flag name?' },
      undefined,
      undefined,
      contextOf(root),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/is finished, not live\..*Nothing was queued/);
  expect((failure as Error).message).not.toContain('advertises no Tau inbox');

  const { records } = await readAskRecords(root);
  const record = records[0] as LiveAskRecord;

  expect(records).toMatchObject([{ route: 'live', status: 'failed' }]);
  expect(record.detail).toMatch(/is finished, not live/);
});

it('a live ask whose architect terminal cannot be read saves no record', async ({
  onTestFinished: cleanup,
}) => {
  const { root, hc, tool } = await liveArchitect(cleanup);

  hc.failGet('t-architect', 'terminal not found');

  const failure = await tool
    .execute(
      'call',
      { action: 'ask', question: 'Which flag name?' },
      undefined,
      undefined,
      contextOf(root),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('could not be read');
  expect((failure as Error).message).toContain('No ask was saved');
  await expect(readAskRecords(root)).resolves.toEqual({ records: [], gaps: [] });
});

it('a refused live ask marks its record failed', async ({ onTestFinished: cleanup }) => {
  const { root, hc, tool } = await liveArchitect(cleanup);

  replyTerminal(hc, 't-architect', leadLabel('session-newer'));

  const failure = await tool
    .execute(
      'call',
      { action: 'ask', question: 'Which flag name?' },
      undefined,
      undefined,
      contextOf(root),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/changed session.*Nothing was queued/);

  const { records } = await readAskRecords(root);
  const record = records[0] as LiveAskRecord;

  expect(records).toMatchObject([{ route: 'live', status: 'failed' }]);
  expect(record.detail).toMatch(/changed session/);
  expect((failure as Error).message).not.toContain(record.askId);
  expect((failure as Error).message).not.toContain('Call architect ask again');
});

it('an unknown live ask retried with its ask ID resends the same bytes and saves once', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const inbox = await startCapturingInbox(cleanup, 'session-architect', 'suppress');

  await recordSession(root, { terminal: 't-architect', sessionId: 'session-architect' });
  await holdLock(root, root);
  await startLeadInbox(cleanup, hc);
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

it('a refused retry after an unknown send keeps the ask unknown', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const inbox = await startCapturingInbox(cleanup, 'session-architect', 'save-then-drop');

  await recordSession(root, { terminal: 't-architect', sessionId: 'session-architect' });
  await holdLock(root, root);
  await startLeadInbox(cleanup, hc);
  replyTerminal(hc, 't-architect', `rpc1:${inbox.path}`);

  const tool = createArchitectTool({ ...hc, cwd: root });

  const asked = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  const { askId } = asked.details as { askId: string };

  expect(asked.details).toMatchObject({ status: 'unknown' });

  const recordBytes = await readFile(askRecordPath(root, askId), 'utf8');

  hc.fail('get', 'transient', 1);

  await expect(
    tool.execute('call', { action: 'ask', askId }, undefined, undefined, contextOf(root)),
  ).rejects.toThrow(new RegExp(`ask ${askId} stays unknown`));

  expect(await readFile(askRecordPath(root, askId), 'utf8')).toBe(recordBytes);
  expect(await readAskRecord(root, askId)).toMatchObject({ status: 'unknown' });
  expect(inbox.frames).toHaveLength(1);

  hc.recover('get');

  const retried = await tool.execute(
    'call',
    { action: 'ask', askId },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(retried.details).toMatchObject({ action: 'ask', status: 'queued', askId });
  expect(await readAskRecord(root, askId)).toMatchObject({ status: 'queued' });
  expect(inbox.saved()).toEqual([`${askId}.json`]);
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

const missingRecordNote =
  'The question may be in the architect inbox, but its ask record is gone, so the architect cannot answer it. Call architect ask again with the question.';

const startHeldQuestion = async (cleanup: Cleanup) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();

  const lead = await startLeadInbox(cleanup, hc);

  const inbox = await startCapturingInbox(cleanup, 'session-architect', 'hold');

  await recordSession(root, { terminal: 't-architect', sessionId: 'session-architect' });
  await holdLock(root, root);
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

  const answered = await createArchitectAnswerTool(
    { ...hc, cwd: root },
    createAnswerTracker(),
  ).execute(
    'call',
    { action: 'answer', askId: record.askId, file: 'answer.md' },
    undefined,
    undefined,
    contextOf(root, {}, 'session-architect'),
  );

  vi.stubEnv('HC_TERMINAL_ID', 't-lead');
  expect(answered.details).toEqual({ action: 'answer', status: 'queued', askId: record.askId });

  inbox.releaseFirst();

  const asked = await asking;

  expect(asked.details).toMatchObject({ action: 'ask', status: 'unknown', askId: record.askId });
  expect((asked.details as { note: string }).note).not.toContain('Retry');
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

  await endArchitectSession(
    session,
    { ...hc, cwd: root },
    createAnswerTracker(),
    createAskAdmissions(() => undefined),
  );

  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  expect(await readAskRecord(root, record.askId)).toMatchObject({ status: 'failed' });

  inbox.releaseFirst();

  const asked = await asking;

  expect(asked.details).toMatchObject({ action: 'ask', status: 'unknown', askId: record.askId });
  expect((asked.details as { note: string }).note).not.toContain('Retry');
  expect(await readAskRecord(root, record.askId)).toMatchObject({ status: 'failed' });
  const savedNames = lead.savedRecords().filter((name) => name.endsWith('.json'));

  expect(savedNames).toHaveLength(1);
});

it('a lost reply on a deleted ask returns unknown and leaves no record', async ({
  onTestFinished: cleanup,
}) => {
  const { root, inbox, asking, record } = await startHeldQuestion(cleanup);

  await rm(askRecordPath(root, record.askId), { force: true });
  inbox.releaseFirst();

  const asked = await asking;

  expect(asked.details).toMatchObject({
    action: 'ask',
    status: 'unknown',
    askId: record.askId,
    note: missingRecordNote,
  });

  await expect(readAskRecord(root, record.askId)).resolves.toBeUndefined();
});

it('a confirmed send on a deleted ask returns queued and tells the lead to ask again', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  let askId = '';

  const inbox = await startCapturingInbox(
    cleanup,
    'session-architect',
    'reply',
    async (messageId) => {
      askId = messageId;
      await rm(askRecordPath(root, messageId), { force: true });
    },
  );

  await recordSession(root, { terminal: 't-architect', sessionId: 'session-architect' });
  await holdLock(root, root);
  await startLeadInbox(cleanup, hc);
  replyTerminal(hc, 't-architect', `rpc1:${inbox.path}`);

  const result = await createArchitectTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({
    action: 'ask',
    status: 'queued',
    askId,
    note: missingRecordNote,
  });

  await expect(readAskRecord(root, askId)).resolves.toBeUndefined();
});

it('a live ask reports a confirmed send when the ask closed before its record update', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  let askId = '';

  const inbox = await startCapturingInbox(
    cleanup,
    'session-architect',
    'reply',
    async (messageId) => {
      askId = messageId;

      await writeAskRecord(root, {
        ...liveRecord('failed'),
        askId,
        status: 'failed',
        detail: 'The architect closed before it answered.',
      });
    },
  );

  await recordSession(root, { terminal: 't-architect', sessionId: 'session-architect' });
  await holdLock(root, root);
  await startLeadInbox(cleanup, hc);
  replyTerminal(hc, 't-architect', `rpc1:${inbox.path}`);

  const result = await createArchitectTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'queued', askId });
  expect((result.details as { note: string }).note).toContain('left unchanged');
  expect(await readAskRecord(root, askId)).toMatchObject({ status: 'failed' });
  expect(inbox.saved()).toEqual([`${askId}.json`]);
});

const breakRecord = async (root: string, askId: string): Promise<void> => {
  await rm(askRecordPath(root, askId), { force: true });
  await mkdir(askRecordPath(root, askId));
};

it('a live ask returns its ask ID with a note when the record write fails after a confirmed send', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  let askId = '';

  const inbox = await startCapturingInbox(
    cleanup,
    'session-architect',
    'reply',
    async (messageId) => {
      askId = messageId;

      await breakRecord(root, askId);
    },
  );

  await recordSession(root, { terminal: 't-architect', sessionId: 'session-architect' });
  await holdLock(root, root);
  await startLeadInbox(cleanup, hc);
  replyTerminal(hc, 't-architect', `rpc1:${inbox.path}`);

  const result = await createArchitectTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  const { note } = result.details as { note: string };

  expect(result.details).toMatchObject({
    action: 'ask',
    status: 'queued',
    askId,
    terminal: 't-architect',
  });

  expect(note).toContain('could not be updated');
  expect(note).toContain('EISDIR');
  expect(note).toContain('Do not ask the question again as new');
  expect(inbox.saved()).toEqual([`${askId}.json`]);
});

it('a live ask returns unknown with its ask ID and a note when the record write fails after a lost reply', async ({
  onTestFinished: cleanup,
}) => {
  const { root, inbox, asking, record } = await startHeldQuestion(cleanup);

  await breakRecord(root, record.askId);
  inbox.releaseFirst();

  const asked = await asking;
  const { note } = asked.details as { note: string };

  expect(asked.details).toMatchObject({
    action: 'ask',
    status: 'unknown',
    askId: record.askId,
    terminal: 't-architect',
  });

  expect(note).toContain('could not be updated');
  expect(note).toContain('EISDIR');
  expect(note).toContain('Do not ask the question again as new');
  expect(note).not.toContain('Retry');
  expect(note).not.toContain('askId');
});

it('a live ask reports a confirmed send when its record disappeared', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  let askId = '';

  const inbox = await startCapturingInbox(
    cleanup,
    'session-architect',
    'reply',
    async (messageId) => {
      askId = messageId;

      await rm(askRecordPath(root, askId), { force: true });
    },
  );

  await recordSession(root, { terminal: 't-architect', sessionId: 'session-architect' });
  await holdLock(root, root);
  await startLeadInbox(cleanup, hc);
  replyTerminal(hc, 't-architect', `rpc1:${inbox.path}`);

  const result = await createArchitectTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'queued', askId });
  await expect(readAskRecord(root, askId)).resolves.toBeUndefined();
  expect(inbox.saved()).toEqual([`${askId}.json`]);
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
