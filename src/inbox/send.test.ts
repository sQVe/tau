import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { succeededResult } from '../../tests/execFake.js';
import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { createHcFake } from '../../tests/hcFake.js';
import type { HcFake } from '../../tests/hcFake.js';
import type { Exec } from '../command.js';
import type { HcRuntime } from '../hc/hc.js';
import { serializeRecord } from '../record.js';
import { envelopeByteLimit } from './envelope.js';
import { sendInboxMessage } from './inbox.js';
import type { InboxSender } from './inbox.js';

interface TerminalFacts {
  state?: string;
  labels?: Record<string, string>;
  name?: string | null;
}

const callerAddress = 'caller';

const handoverSender: InboxSender = {
  toolName: 'handover',
  recovery: 'Use handover start to open a receiver instead.',
};

beforeEach(() => {
  vi.stubEnv('HC_TERMINAL_ID', callerAddress);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const runtimeOf = (fake: HcFake): HcRuntime => ({
  exec: fake.exec,
  connect: fake.connect,
  cwd: '/repository',
});

const terminalReply = (address: string, facts: TerminalFacts = {}): string =>
  JSON.stringify({
    address,
    name: facts.name ?? null,
    state: facts.state ?? 'live',
    labels: facts.labels ?? {},
  });

const lease = (sessionId: string, expiresAt: number): string => `${sessionId}:${expiresAt}`;

const liveLease = (): string => lease('session-1', Date.now() + 60_000);

const abortOnSecondCheck = (): AbortSignal => {
  let checks = 0;
  const controller = new AbortController();

  return {
    throwIfAborted: () => {
      checks += 1;

      if (checks >= 2) {
        controller.abort();
      }

      controller.signal.throwIfAborted();
    },
  } as unknown as AbortSignal;
};

const labelArguments = (fake: HcFake): string[][] =>
  fake.calls
    .filter((call) => call.commandArguments[0] === 'label')
    .map((call) => call.commandArguments);

const sendArguments = (fake: HcFake): string[][] =>
  fake.calls
    .filter((call) => call.commandArguments[0] === 'send')
    .map((call) => call.commandArguments);

const envelopePathOf = (root: string, messageId: string): string =>
  join(root, '.tau', 'inbox', `${messageId}.json`);

const savedEnvelope = async (root: string, messageId: string): Promise<Record<string, unknown>> => {
  const text = await readFile(envelopePathOf(root, messageId), 'utf8');

  return JSON.parse(text) as Record<string, unknown>;
};

it('queues one envelope and one label for a receiver with a live lease', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);

  fake.reply('get', terminalReply('t7', { labels: { 'tau.inbox': liveLease() } }));
  fake.reply('label', terminalReply('t7'));

  const result = await sendInboxMessage({
    hc: runtimeOf(fake),
    target: 't7',
    family: 'handover',
    sender: handoverSender,
    text: 'Next steps\n',
    cwd: root,
  });

  expect(result).toMatchObject({ status: 'queued', terminal: 't7' });
  expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);

  expect(await savedEnvelope(root, result.messageId)).toEqual({
    version: 2,
    messageId: result.messageId,
    targetTerminal: 't7',
    targetSessionId: 'session-1',
    family: 'handover',
    text: 'Next steps\n',
  });

  expect(labelArguments(fake)).toEqual([
    [
      'label',
      '--json',
      '--',
      't7',
      `tau.inbox.${result.messageId}=${envelopePathOf(root, result.messageId)}`,
    ],
  ]);

  expect(sendArguments(fake)).toEqual([]);
});

it.each([
  {
    case: 'no lease',
    target: 't7',
    reply: terminalReply('t7'),
    message: /has no inbox lease/,
  },
  {
    case: 'a receiver without a labels map',
    target: 't7',
    reply: JSON.stringify({ address: 't7', name: null, state: 'live' }),
    message: /has no inbox lease/,
  },
  {
    case: 'a malformed lease',
    target: 't7',
    reply: terminalReply('t7', { labels: { 'tau.inbox': 'nonsense' } }),
    message: /malformed inbox lease/,
  },
  {
    case: 'an expired lease',
    target: 't7',
    reply: terminalReply('t7', { labels: { 'tau.inbox': lease('session-1', Date.now() - 1000) } }),
    message: /expired inbox lease/,
  },
  {
    case: 'a lease with an oversized session ID',
    target: 't7',
    reply: terminalReply('t7', {
      labels: { 'tau.inbox': lease('s'.repeat(501), Date.now() + 60_000) },
    }),
    message: /malformed inbox lease/,
  },
  {
    case: "the caller's own address",
    target: callerAddress,
    reply: terminalReply(callerAddress, { labels: { 'tau.inbox': liveLease() } }),
    message: /own terminal/,
  },
  {
    case: 'a name that resolves to the caller',
    target: 'worker',
    reply: terminalReply(callerAddress, { name: 'worker', labels: { 'tau.inbox': liveLease() } }),
    message: /own terminal/,
  },
  {
    case: 'another machine',
    target: 'machine/t7',
    reply: terminalReply('machine/t7', { labels: { 'tau.inbox': liveLease() } }),
    message: /another machine/,
  },
  {
    case: 'a target that resolves to another machine',
    target: 'remote',
    reply: terminalReply('machine/t7', { labels: { 'tau.inbox': liveLease() } }),
    message: /another machine/,
  },
  {
    case: 'a receiver that is not live',
    target: 't7',
    reply: terminalReply('t7', {
      state: 'exited',
      labels: { 'tau.inbox': liveLease() },
    }),
    message: /not live/,
  },
])('refuses $case without writing a file or label', async ({ target, reply, message }) => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);

  fake.reply('get', reply);

  const caught = await sendInboxMessage({
    hc: runtimeOf(fake),
    target,
    family: 'handover',
    sender: handoverSender,
    text: 'Next steps\n',
    cwd: root,
  }).catch((error: unknown) => error);

  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/handover start/);
  expect((caught as Error).message).toMatch(message);
  expect(existsSync(join(root, '.tau'))).toBe(false);
  expect(labelArguments(fake)).toEqual([]);
});

it('refuses when the caller has no terminal', async () => {
  vi.stubEnv('HC_TERMINAL_ID', '');

  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);

  const caught = await sendInboxMessage({
    hc: runtimeOf(fake),
    target: 't7',
    family: 'handover',
    sender: handoverSender,
    text: 'Next steps\n',
    cwd: root,
  }).catch((error: unknown) => error);

  expect((caught as Error).message).toMatch(/handover start/);
  expect(existsSync(join(root, '.tau'))).toBe(false);
  expect(labelArguments(fake)).toEqual([]);
});

it('writes nothing when the caller aborts during the target lookup', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();

  const exec: Exec = async (command, commandArguments, options) => {
    const result = await fake.exec(command, commandArguments, options);

    if (commandArguments[0] === 'get') {
      controller.abort();
    }

    return result;
  };

  fake.reply('get', terminalReply('t7', { labels: { 'tau.inbox': liveLease() } }));

  const hc: HcRuntime = {
    exec,
    connect: fake.connect,
    cwd: '/repository',
    signal: controller.signal,
  };

  await expect(
    sendInboxMessage({
      hc,
      target: 't7',
      family: 'handover',
      sender: handoverSender,
      text: 'Next steps\n',
      cwd: root,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });

  expect(existsSync(join(root, '.tau'))).toBe(false);
  expect(labelArguments(fake)).toEqual([]);
});

it('writes nothing when request.signal aborts a pending target lookup', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();
  const fake = createHcFake();
  const calls: string[][] = [];
  let lookupStarted = false;

  const exec: Exec = async (_command, commandArguments, options) => {
    calls.push([...commandArguments]);

    if (commandArguments[0] === 'get') {
      lookupStarted = true;

      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted === true) {
          resolve();

          return;
        }

        options?.signal?.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });

      options?.signal?.throwIfAborted();
    }

    return succeededResult('');
  };

  const hc: HcRuntime = { exec, connect: fake.connect, cwd: '/repository' };

  const pending = sendInboxMessage({
    hc,
    target: 't7',
    family: 'handover',
    sender: handoverSender,
    text: 'Next steps\n',
    cwd: root,
    signal: controller.signal,
  }).catch((error: unknown) => error);

  await vi.waitFor(() => {
    expect(lookupStarted).toBe(true);
  });

  controller.abort();

  const caught = await pending;

  expect(caught).toBeInstanceOf(Error);
  expect(existsSync(join(root, '.tau'))).toBe(false);
  expect(calls.filter((call) => call[0] === 'label')).toEqual([]);
});

it('reports the envelope path when the label write fails and sets no second label', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);

  fake.reply('get', terminalReply('t7', { labels: { 'tau.inbox': liveLease() } }));
  fake.fail('label', JSON.stringify({ error: { kind: 'failed', message: 'label failed' } }), 1);

  const caught = await sendInboxMessage({
    hc: runtimeOf(fake),
    target: 't7',
    family: 'handover',
    sender: handoverSender,
    text: 'Next steps\n',
    cwd: root,
  }).catch((error: unknown) => error);

  const files = await readdir(join(root, '.tau', 'inbox'));
  const [envelopeName] = files;

  expect(files).toHaveLength(1);
  expect(envelopeName).toBeDefined();
  expect((caught as Error).message).toContain(join(root, '.tau', 'inbox', envelopeName as string));
  expect((caught as Error).message).toMatch(/may or may not be set/);
  expect((caught as Error).message).toMatch(/Nothing is retried/);
  expect(labelArguments(fake)).toHaveLength(1);
});

it('rejects when the caller aborts a pending label write', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();
  const fake = createHcFake();
  const calls: string[][] = [];
  let labelStarted = false;

  const exec: Exec = async (_command, commandArguments, options) => {
    calls.push([...commandArguments]);

    if (commandArguments[0] === 'get') {
      return succeededResult(terminalReply('t7', { labels: { 'tau.inbox': liveLease() } }));
    }

    if (commandArguments[0] === 'label') {
      labelStarted = true;

      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted === true) {
          resolve();

          return;
        }

        options?.signal?.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });

      options?.signal?.throwIfAborted();
    }

    return succeededResult('');
  };

  const hc: HcRuntime = { exec, connect: fake.connect, cwd: '/repository' };

  const pending = sendInboxMessage({
    hc,
    target: 't7',
    family: 'handover',
    sender: handoverSender,
    text: 'Next steps\n',
    cwd: root,
    signal: controller.signal,
  }).catch((error: unknown) => error);

  await vi.waitFor(() => {
    expect(labelStarted).toBe(true);
  });

  controller.abort();

  const caught = await pending;

  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/may or may not be set/);
  expect(calls.filter((call) => call[0] === 'label')).toHaveLength(1);
});

it('reports the written envelope and sets no label when the caller aborts after the write', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);

  fake.reply('get', terminalReply('t7', { labels: { 'tau.inbox': liveLease() } }));

  const caught = await sendInboxMessage({
    hc: runtimeOf(fake),
    target: 't7',
    family: 'handover',
    sender: handoverSender,
    text: 'Next steps\n',
    cwd: root,
    signal: abortOnSecondCheck(),
  }).catch((error: unknown) => error);

  const files = await readdir(join(root, '.tau', 'inbox'));
  const [envelopeName] = files;

  expect(files).toHaveLength(1);
  expect((caught as Error).message).toContain(join(root, '.tau', 'inbox', envelopeName as string));
  expect(labelArguments(fake)).toEqual([]);
});

it('keeps the text as it was at send time after the source file changes', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const source = join(root, 'message.md');

  await writeFile(source, 'First text\n');
  fake.reply('get', terminalReply('t7', { labels: { 'tau.inbox': liveLease() } }));
  fake.reply('label', terminalReply('t7'));

  const text = await readFile(source, 'utf8');

  const result = await sendInboxMessage({
    hc: runtimeOf(fake),
    target: 't7',
    family: 'handover',
    sender: handoverSender,
    text,
    cwd: root,
  });

  await writeFile(source, 'Second text\n');

  expect((await savedEnvelope(root, result.messageId))['text']).toBe('First text\n');
});

it.each([
  { case: 'ASCII', text: 'x'.repeat(102_400) },
  { case: 'multi-byte UTF-8', text: 'é'.repeat(60_000) },
])('refuses $case text that makes the envelope too large before any write', async ({ text }) => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);

  fake.reply('get', terminalReply('t7', { labels: { 'tau.inbox': liveLease() } }));

  const caught = await sendInboxMessage({
    hc: runtimeOf(fake),
    target: 't7',
    family: 'handover',
    sender: handoverSender,
    text,
    cwd: root,
  }).catch((error: unknown) => error);

  expect((caught as Error).message).toMatch(/larger than/);
  expect(existsSync(join(root, '.tau'))).toBe(false);
  expect(labelArguments(fake)).toEqual([]);
});

it('accepts an envelope whose written bytes are exactly the limit', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);

  const placeholder = {
    version: 1 as const,
    messageId: '0'.repeat(36),
    targetTerminal: 't7',
    targetSessionId: 'session-1',
    family: 'handover' as const,
    text: '',
  };

  const overhead = Buffer.byteLength(serializeRecord(placeholder), 'utf8');
  const text = 'x'.repeat(envelopeByteLimit - overhead);

  fake.reply('get', terminalReply('t7', { labels: { 'tau.inbox': liveLease() } }));
  fake.reply('label', terminalReply('t7'));

  const result = await sendInboxMessage({
    hc: runtimeOf(fake),
    target: 't7',
    family: 'handover',
    sender: handoverSender,
    text,
    cwd: root,
  });

  expect(result.status).toBe('queued');
});
