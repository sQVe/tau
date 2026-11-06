import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { succeededResult } from '../../tests/execFake.js';
import { startHandoverReceiver } from '../../tests/inboxReceiverHarness.js';
import type { HcRuntime } from '../hc/hc.js';
import { sendInboxMessage } from './inbox.js';
import type { InboxSendRequest } from './inbox.js';

const refusal = 'Nothing was queued. Use handover start to open a receiver instead.';

let root = '';
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  root = mkdtempSync('/tmp/tau-send-');
  chmodSync(root, 0o700);
  vi.stubEnv('HC_TERMINAL_ID', 't1');
});

afterEach(async () => {
  vi.useRealTimers();

  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }

  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const startReceiver = (terminal: string) => startHandoverReceiver(onTestFinished, root, terminal);

// Answers `hc get` with one terminal snapshot.
const hcFor = (terminal: Record<string, unknown>): HcRuntime => ({
  exec: () => Promise.resolve(succeededResult(JSON.stringify(terminal))),
  connect: () => Promise.reject(new Error('no connect')),
  cwd: root,
});

const request = (hc: HcRuntime, messageId?: string): InboxSendRequest => ({
  hc,
  target: 'peer',
  body: { family: 'handover', payload: { text: 'handover text' } },
  messageId,
  refusal,
});

const liveTarget = (path: string) => ({
  address: 't7',
  state: 'live',
  labels: { 'tau.inbox': `rpc1:${path}` },
});

// A socket server for session `sessionId` that runs `answer` once the client finished its request.
const scriptedServer = async (
  sessionId: string,
  answer: (socket: Socket, request: string) => void,
) => {
  const path = join(root, `${sessionId}.sock`);
  const sockets = new Set<Socket>();

  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    let text = '';

    sockets.add(socket);
    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      text += chunk;
    });

    socket.once('end', () => {
      answer(socket, text);
    });

    socket.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });

        for (const socket of sockets) {
          socket.destroy();
        }
      }),
  );

  return path;
};

it('sends one message frame over one connection and returns the queued reply', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const requests: string[] = [];

  const path = await scriptedServer(sessionId, (socket, text) => {
    requests.push(text);

    socket.end(
      `${JSON.stringify({ protocol: 'rpc1', kind: 'queued', messageId, terminal: 't7', sessionId })}\n`,
    );
  });

  await expect(sendInboxMessage(request(hcFor(liveTarget(path)), messageId))).resolves.toEqual({
    status: 'queued',
    terminal: 't7',
    sessionId,
    messageId,
  });

  expect(requests.map((text) => JSON.parse(text) as unknown)).toEqual([
    {
      protocol: 'rpc1',
      kind: 'message',
      messageId,
      targetTerminal: 't7',
      targetSessionId: sessionId,
      family: 'handover',
      payload: { text: 'handover text' },
    },
  ]);
});

it('queues a handover after the receiver saved it', async () => {
  const receiver = await startReceiver('t7');
  const messageId = randomUUID();

  await expect(
    sendInboxMessage(request(hcFor(liveTarget(receiver.path)), messageId)),
  ).resolves.toEqual({
    status: 'queued',
    terminal: 't7',
    sessionId: receiver.sessionId,
    messageId,
  });

  expect(receiver.savedRecords()).toEqual([
    receiver.sessionId,
    join(receiver.sessionId, `${messageId}.json`),
  ]);
});

it.each([
  ['a remote terminal', { address: 'machine/t7' }, 'Terminal machine/t7 is on another machine.'],
  ['its own terminal', { address: 't1' }, "Terminal t1 is this session's own terminal."],
  ['a finished terminal', { state: 'finished' }, 'Terminal t7 is finished, not live.'],
  ['a terminal without a label', { labels: {} }, 'Terminal t7 advertises no Tau inbox.'],
  [
    'an unknown protocol',
    { labels: { 'tau.inbox': 'rpc9:/tmp/x.sock' } },
    'Terminal t7 advertises inbox protocol "rpc9", not rpc1.',
  ],
])('refuses %s before connecting and saves nothing', async (_name, change, reason) => {
  const receiver = await startReceiver('t7');

  await expect(
    sendInboxMessage(request(hcFor({ ...liveTarget(receiver.path), ...change }))),
  ).rejects.toThrow(`${reason} ${refusal}`);

  expect(receiver.savedRecords()).toEqual([]);
});

it('refuses a peer whose inbox answers for another terminal', async () => {
  const receiver = await startReceiver('t9');

  await expect(sendInboxMessage(request(hcFor(liveTarget(receiver.path))))).rejects.toThrow(
    `This inbox is terminal t9, session ${receiver.sessionId}. ${refusal}`,
  );

  expect(receiver.savedRecords()).toEqual([]);
});

it('refuses a family the receiver does not accept', async () => {
  const receiver = await startReceiver('t7');

  await expect(
    sendInboxMessage({
      ...request(hcFor(liveTarget(receiver.path))),
      body: {
        family: 'answer',
        payload: {
          assignmentId: randomUUID(),
          questionId: randomUUID(),
          parentSession: 'manager-session',
          answer: 'Use option A.',
        },
      },
    }),
  ).rejects.toThrow(`This session does not accept answer messages. ${refusal}`);

  expect(receiver.savedRecords()).toEqual([]);
});

it('refuses a socket that refuses connections', async () => {
  const path = join(root, `${randomUUID()}.sock`);

  writeFileSync(path, '');

  await expect(sendInboxMessage(request(hcFor(liveTarget(path))))).rejects.toThrow(
    `The inbox of t7 did not answer: connect ECONNREFUSED ${path} ${refusal}`,
  );
});

it('returns unknown with the same message ID when the message gets no reply in time', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const requests: string[] = [];

  const path = await scriptedServer(sessionId, (_socket, text) => {
    requests.push(text);
  });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const result = sendInboxMessage(request(hcFor(liveTarget(path)), messageId));

  await vi.waitFor(() => {
    expect(requests).toHaveLength(1);
  });

  await vi.advanceTimersByTimeAsync(5000);

  await expect(result).resolves.toMatchObject({
    status: 'unknown',
    sessionId,
    messageId,
    note: expect.stringContaining('No reply within 5000 ms.') as string,
  });
});

it('returns unknown with the same message ID when the message reply is lost', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();

  const path = await scriptedServer(sessionId, (socket) => {
    socket.destroy();
  });

  const result = await sendInboxMessage(request(hcFor(liveTarget(path)), messageId));

  expect(result).toMatchObject({ status: 'unknown', terminal: 't7', sessionId, messageId });

  expect(result.note).toContain(
    `Acceptance unknown for message ${messageId} to terminal t7, session ${sessionId}; the receiver may have saved it. A retry must reuse this message ID and the same text.`,
  );
});

it('refuses a message larger than the frame limit before sending it', async () => {
  const receiver = await startReceiver('t7');

  await expect(
    sendInboxMessage({
      ...request(hcFor(liveTarget(receiver.path))),
      body: { family: 'handover', payload: { text: '"'.repeat(60_000) } },
    }),
  ).rejects.toThrow(`The message is larger than the 102400-byte frame limit. ${refusal}`);

  expect(receiver.savedRecords()).toEqual([]);
});

it('returns unknown when the receiver queues another message ID', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();

  const path = await scriptedServer(sessionId, (socket) => {
    socket.end(
      `${JSON.stringify({ protocol: 'rpc1', kind: 'queued', messageId: randomUUID(), terminal: 't7', sessionId })}\n`,
    );
  });

  const result = await sendInboxMessage(request(hcFor(liveTarget(path)), messageId));

  expect(result).toMatchObject({ status: 'unknown', sessionId, messageId });
  expect(result.note).toContain('The receiver sent an unexpected reply.');
});
