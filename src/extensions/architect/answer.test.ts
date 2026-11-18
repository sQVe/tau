import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { onTestFinished } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { startHandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import type {
  HandoverReceiver,
  HandoverReceiverOptions,
} from '../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { encodeMessageFrame } from '../../inbox/inbox.js';
import { createAnswerTracker } from './answer.js';
import { contextOf, setup } from './fixtures/toolHarness.js';
import { askRecordDirectory, askRecordPath, readAskRecord, writeAskRecord } from './record.js';
import type { HiddenAskRecord, LiveAskRecord } from './record.js';
import { createArchitectAnswerTool } from './tool.js';

type Cleanup = typeof onTestFinished;

const savedFiles = (receiver: HandoverReceiver): string[] =>
  receiver.savedRecords().filter((name) => name.endsWith('.json'));

const replyTerminal = (hc: HcFake, address: string, path: string): void => {
  hc.replyGet(
    address,
    JSON.stringify({ address, name: null, state: 'live', labels: { 'tau.inbox': `rpc1:${path}` } }),
  );
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

const hiddenRecord = (askId: string): HiddenAskRecord => ({
  version: 2,
  route: 'hidden',
  askId,
  createdAt: '2026-11-18T10:00:00.000Z',
  question: 'Which flag name?',
  sessionFile: '/sessions/architect.jsonl',
  terminal: 't-ask',
  leadTerminal: 't-lead',
  deadline: 1900000000000,
  status: 'running',
  detail: null,
  answer: null,
});

const answering = async (cleanup: Cleanup, options: HandoverReceiverOptions = {}) => {
  const { root } = await setup(cleanup);

  vi.stubEnv('HC_TERMINAL_ID', 't-architect');

  const hc = createHcFake();
  const sockets = temporaryDirectory(cleanup, 'tau-answer-');

  const lead = await startHandoverReceiver(cleanup, sockets, 't-lead', {
    sessionId: 'session-lead',
    ...options,
  });

  replyTerminal(hc, 't-lead', lead.path);
  await writeFile(join(root, 'answer.md'), 'Use --dry-run.\n');

  const answer = (askId: string) =>
    createArchitectAnswerTool({ ...hc, cwd: root }, createAnswerTracker()).execute(
      'call',
      { action: 'answer', askId, file: 'answer.md' },
      undefined,
      undefined,
      contextOf(root, {}, 'session-architect'),
    );

  return { root, hc, lead, answer };
};

it('answer sends the file to the lead session that asked and marks the ask answered', async ({
  onTestFinished: cleanup,
}) => {
  const { root, lead, answer } = await answering(cleanup);
  const record = liveRecord('queued');

  await writeAskRecord(root, record);

  const result = await answer(record.askId);

  expect(result.details).toEqual({ action: 'answer', status: 'queued', askId: record.askId });
  expect(savedFiles(lead)).toEqual([`session-lead/${record.askId}.json`]);

  expect(await readAskRecord(root, record.askId)).toEqual({
    ...record,
    status: 'answered',
    answer: `Answer to ask ${record.askId}:\n\nUse --dry-run.\n`,
  });
});

it('answer to a lead terminal that runs a new session throws and marks the ask failed', async ({
  onTestFinished: cleanup,
}) => {
  const { root, hc, lead, answer } = await answering(cleanup);
  const record = liveRecord('queued');

  await writeAskRecord(root, record);
  replyTerminal(hc, 't-lead', '/tmp/tau-lead/session-newer.sock');

  await expect(answer(record.askId)).rejects.toThrow(
    /changed session.*Tell the user that the answer did not reach the lead/,
  );

  expect(savedFiles(lead)).toEqual([]);
  expect(await readAskRecord(root, record.askId)).toMatchObject({ status: 'failed' });
});

it('answer to a silent lead inbox leaves the ask open and says to call answer again', async ({
  onTestFinished: cleanup,
}) => {
  const { root, hc, answer } = await answering(cleanup);
  const record = liveRecord('queued');
  const directory = join(temporaryDirectory(cleanup, 'tau-silent-'), 'sockets');
  const path = join(directory, 'session-lead.sock');
  const server = createServer((socket) => socket.end());

  mkdirSync(directory);

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  cleanup(() => {
    server.close();
  });

  await writeAskRecord(root, record);
  replyTerminal(hc, 't-lead', path);

  const result = await answer(record.askId);

  expect(result.details).toMatchObject({
    action: 'answer',
    status: 'unknown',
    askId: record.askId,
  });

  expect((result.details as { note: string }).note).toContain(`askId ${record.askId}`);
  expect(await readAskRecord(root, record.askId)).toEqual(record);
});

it.for<[string, string, RegExp]>([
  ['a missing record', 'missing', /No ask record/],
  ['a hidden record', 'hidden', /hidden ask session/],
  ['another architect session', 'other-architect', /architect session session-other/],
  ['an answered ask', 'answered', /already answered/],
  ['a failed ask', 'failed', /already failed/],
])(
  'answer to %s throws its own error and sends nothing',
  async ([, kind, error], { onTestFinished: cleanup }) => {
    const { root, hc, lead, answer } = await answering(cleanup);
    const askId = randomUUID();

    const records: Record<string, HiddenAskRecord | LiveAskRecord | undefined> = {
      missing: undefined,
      hidden: hiddenRecord(askId),
      'other-architect': {
        ...liveRecord('queued'),
        askId,
        architectSessionId: 'session-other',
      },
      answered: { ...liveRecord('answered'), askId },
      failed: { ...liveRecord('failed'), askId },
    };

    const record = records[kind];

    if (record !== undefined) {
      await writeAskRecord(root, record);
    }

    await expect(answer(askId)).rejects.toThrow(error);

    expect(await readAskRecord(root, askId)).toEqual(record);
    expect(savedFiles(lead)).toEqual([]);
    expect(hc.calls).toEqual([]);
  },
);

it('answer queues an answer whose frame is exactly the inbox limit and refuses one byte more', async ({
  onTestFinished: cleanup,
}) => {
  const { root, lead, answer } = await answering(cleanup);
  const record = liveRecord('queued');

  const frameBytes = (fill: number): number =>
    Buffer.byteLength(
      encodeMessageFrame({
        messageId: record.askId,
        targetTerminal: 't-lead',
        targetSessionId: 'session-lead',
        body: {
          family: 'handover',
          payload: { text: `Answer to ask ${record.askId}:\n\n${'a'.repeat(fill)}` },
        },
      }),
    );

  const exactFill = 102_400 - frameBytes(0);

  expect(frameBytes(exactFill)).toBe(102_400);

  await writeAskRecord(root, record);
  await writeFile(join(root, 'answer.md'), 'a'.repeat(exactFill + 1));

  await expect(answer(record.askId)).rejects.toThrow(/102401 bytes, limit 102400/);

  await writeFile(join(root, 'answer.md'), 'a'.repeat(exactFill));

  const result = await answer(record.askId);

  expect(result.details).toEqual({ action: 'answer', status: 'queued', askId: record.askId });
  expect(savedFiles(lead)).toEqual([`session-lead/${record.askId}.json`]);
});

it('answer refuses an ask ID that is not a UUID', async ({ onTestFinished: cleanup }) => {
  const { hc, answer } = await answering(cleanup);

  await expect(answer('../escape')).rejects.toThrow('askId is not a UUID: ../escape');
  expect(hc.calls).toEqual([]);
});

const answerFileCases = [
  {
    name: 'a missing file',
    arrange: (path: string) => rm(path),
    error: 'answer file does not exist: answer.md',
  },
  {
    name: 'a non-regular file',
    arrange: async (path: string) => {
      await rm(path);
      await mkdir(path);
    },
    error: 'answer file is not a regular file: answer.md',
  },
  {
    name: 'an empty file',
    arrange: (path: string) => writeFile(path, ''),
    error: 'answer file is empty: answer.md',
  },
  {
    name: 'an oversized file',
    arrange: (path: string) => writeFile(path, 'a'.repeat(102_401)),
    error: 'answer file is larger than 102400 bytes: answer.md',
  },
];

it.for(answerFileCases)(
  'answer with $name throws its own error, sends nothing, and leaves the ask record unchanged',
  async ({ arrange, error }, { onTestFinished: cleanup }) => {
    const { root, hc, lead, answer } = await answering(cleanup);
    const record = liveRecord('queued');
    const path = askRecordPath(root, record.askId);

    await writeAskRecord(root, record);

    const bytesBefore = await readFile(path, 'utf8');

    await arrange(join(root, 'answer.md'));

    await expect(answer(record.askId)).rejects.toThrow(error);

    await expect(readFile(path, 'utf8')).resolves.toBe(bytesBefore);
    expect(savedFiles(lead)).toEqual([]);
    expect(hc.calls).toEqual([]);
  },
);

it.for(answerFileCases)(
  'answer with a valid file after $name queues the answer and marks the ask answered',
  async ({ arrange, error }, { onTestFinished: cleanup }) => {
    const { root, lead, answer } = await answering(cleanup);
    const record = liveRecord('queued');

    await writeAskRecord(root, record);
    await arrange(join(root, 'answer.md'));
    await expect(answer(record.askId)).rejects.toThrow(error);

    await rm(join(root, 'answer.md'), { recursive: true, force: true });
    await writeFile(join(root, 'answer.md'), 'Use --dry-run.\n');

    const retried = await answer(record.askId);

    expect(retried.details).toEqual({ action: 'answer', status: 'queued', askId: record.askId });
    expect(savedFiles(lead)).toEqual([`session-lead/${record.askId}.json`]);

    expect(await readAskRecord(root, record.askId)).toEqual({
      ...record,
      status: 'answered',
      answer: `Answer to ask ${record.askId}:\n\nUse --dry-run.\n`,
    });
  },
);

const oversizedFrameCases = [
  { name: 'a plain file near the read limit', text: 'a'.repeat(102_400) },
  { name: 'a smaller file that JSON escaping expands', text: '"'.repeat(60_000) },
];

it.for(oversizedFrameCases)(
  'answer with $name throws the frame size error, sends nothing, and leaves the record unchanged',
  async ({ text }, { onTestFinished: cleanup }) => {
    const { root, hc, lead, answer } = await answering(cleanup);
    const record = liveRecord('queued');
    const path = askRecordPath(root, record.askId);

    await writeAskRecord(root, record);

    const bytesBefore = await readFile(path, 'utf8');

    await writeFile(join(root, 'answer.md'), text);

    await expect(answer(record.askId)).rejects.toThrow(
      /^The answer is too large for one inbox message: \d+ bytes, limit 102400\. Shorten the answer file and call architect answer again\.$/,
    );

    await expect(readFile(path, 'utf8')).resolves.toBe(bytesBefore);
    expect(savedFiles(lead)).toEqual([]);
    expect(hc.calls).toEqual([]);
  },
);

it('answer with a shorter file after a frame size error queues it and marks the ask answered', async ({
  onTestFinished: cleanup,
}) => {
  const { root, lead, answer } = await answering(cleanup);
  const record = liveRecord('queued');

  await writeAskRecord(root, record);
  await writeFile(join(root, 'answer.md'), '"'.repeat(60_000));
  await expect(answer(record.askId)).rejects.toThrow(/too large for one inbox message/);

  await writeFile(join(root, 'answer.md'), '"'.repeat(1000));

  const retried = await answer(record.askId);

  expect(retried.details).toEqual({ action: 'answer', status: 'queued', askId: record.askId });
  expect(savedFiles(lead)).toEqual([`session-lead/${record.askId}.json`]);
  expect(await readAskRecord(root, record.askId)).toMatchObject({ status: 'answered' });
});

it.for([
  ['an askId that is not a UUID', 'not-a-uuid'],
  ['an askId that does not match its file name', '0190c1d2-0000-7000-8000-000000000601'],
])(
  'answer to a record with %s throws and leaves the file unchanged',
  async ([, savedAskId], { onTestFinished: cleanup }) => {
    const { root, hc, lead, answer } = await answering(cleanup);
    const askId = randomUUID();
    const path = askRecordPath(root, askId);
    const saved = JSON.stringify({ ...liveRecord('queued'), askId: savedAskId });

    await mkdir(askRecordDirectory(root), { recursive: true });
    await writeFile(path, saved);

    await expect(answer(askId)).rejects.toThrow(`Malformed ask record ${path}`);

    await expect(readFile(path, 'utf8')).resolves.toBe(saved);
    expect(savedFiles(lead)).toEqual([]);
    expect(hc.calls).toEqual([]);
  },
);

it('answer keeps a confirmed delivery when the ask closed before its record update', async ({
  onTestFinished: cleanup,
}) => {
  let root = '';
  let askId = '';

  const configured = await answering(cleanup, {
    accepts: {
      handover: async (_request, save) => {
        const reply = await save();

        await writeAskRecord(root, {
          ...liveRecord('failed'),
          askId,
          status: 'failed',
          detail: 'The architect closed before it answered.',
        });

        return reply;
      },
    },
  });

  root = configured.root;

  const record = liveRecord('queued');

  askId = record.askId;
  await writeAskRecord(root, record);

  const result = await configured.answer(record.askId);

  expect(result.details).toMatchObject({ action: 'answer', status: 'queued', askId });
  expect((result.details as { note: string }).note).toContain('left unchanged');
  expect((result.details as { note: string }).note).not.toContain('answer again');
  expect(savedFiles(configured.lead)).toEqual([`session-lead/${askId}.json`]);
  expect(await readAskRecord(root, askId)).toMatchObject({ status: 'failed' });
});

it('answer keeps a confirmed delivery when the record update fails and reports the failure', async ({
  onTestFinished: cleanup,
}) => {
  let root = '';
  let askId = '';

  const configured = await answering(cleanup, {
    accepts: {
      handover: async (_request, save) => {
        const reply = await save();

        await rm(askRecordPath(root, askId), { force: true });
        await mkdir(askRecordPath(root, askId));

        return reply;
      },
    },
  });

  root = configured.root;

  const record = liveRecord('queued');

  askId = record.askId;
  await writeAskRecord(root, record);

  const result = await configured.answer(askId);
  const { note } = result.details as { note: string };

  expect(result.details).toMatchObject({ action: 'answer', status: 'queued', askId });
  expect(note).toContain('The answer reached the lead inbox');
  expect(note).toContain('could not be updated');
  expect(note).toContain('EISDIR');
  expect(note).toContain('Do not send it again');
  expect(note).not.toContain('answer again');
  expect(savedFiles(configured.lead)).toEqual([`session-lead/${askId}.json`]);
});

it('answer keeps a confirmed delivery when its record disappeared', async ({
  onTestFinished: cleanup,
}) => {
  let root = '';
  let askId = '';

  const configured = await answering(cleanup, {
    accepts: {
      handover: async (_request, save) => {
        const reply = await save();

        await rm(askRecordPath(root, askId), { force: true });

        return reply;
      },
    },
  });

  root = configured.root;

  const record = liveRecord('queued');

  askId = record.askId;
  await writeAskRecord(root, record);

  const result = await configured.answer(record.askId);

  expect(result.details).toMatchObject({ action: 'answer', status: 'queued', askId });
  await expect(readAskRecord(root, askId)).resolves.toBeUndefined();
  expect(savedFiles(configured.lead)).toEqual([`session-lead/${askId}.json`]);
});
