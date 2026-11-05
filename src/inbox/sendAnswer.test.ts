import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { createHcFake } from '../../tests/hcFake.js';
import type { HcFake } from '../../tests/hcFake.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import type { HcRuntime } from '../hc/hc.js';
import { readEnvelope } from './envelope.js';
import { checkInboxTarget, sendInboxMessage } from './inbox.js';

const callerAddress = 'caller';

const answerText = '{"assignmentId":"a","questionId":"q","answerPath":"/answers/q.json"}';

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

const terminalReply = (labels: Record<string, string>): string =>
  JSON.stringify({ address: 't7', name: null, state: 'live', labels });

const liveLease = (sessionId: string): string => `${sessionId}:${Date.now() + 60_000}`;

const labelArguments = (fake: HcFake): string[][] =>
  fake.calls
    .filter((call) => call.commandArguments[0] === 'label')
    .map((call) => call.commandArguments);

const caughtError = async (promise: Promise<unknown>): Promise<Error> => {
  const caught = await promise.catch((error: unknown) => error);

  if (!(caught instanceof Error)) {
    throw new TypeError('Expected a refusal.');
  }

  return caught;
};

it('writes an answer envelope at version 2 that the receiver reads', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);

  fake.reply('get', terminalReply({ 'tau.inbox': liveLease('session-1') }));
  fake.reply('label', terminalReply({}));

  const result = await sendInboxMessage({
    hc: runtimeOf(fake),
    target: 't7',
    family: 'answer',
    text: answerText,
    cwd: root,
  });

  const path = join(root, '.tau', 'inbox', `${result.messageId}.json`);

  await expect(
    readEnvelope(path, { messageId: result.messageId, terminal: 't7' }),
  ).resolves.toEqual({
    kind: 'valid',
    envelope: {
      version: 2,
      messageId: result.messageId,
      targetTerminal: 't7',
      targetSessionId: 'session-1',
      family: 'answer',
      text: answerText,
    },
  });
});

it('returns the terminal and lease session of a live receiver', async () => {
  const fake = createHcFake();

  fake.reply('get', terminalReply({ 'tau.inbox': liveLease('session-1') }));

  await expect(
    checkInboxTarget({ hc: runtimeOf(fake), target: 't7', family: 'answer' }),
  ).resolves.toEqual({
    terminal: 't7',
    sessionId: 'session-1',
  });

  expect(labelArguments(fake)).toEqual([]);
});

it.each([
  { case: 'no lease', labels: {} },
  { case: 'an expired lease', labels: { 'tau.inbox': `session-1:${Date.now() - 1000}` } },
  { case: 'a malformed lease', labels: { 'tau.inbox': 'nonsense' } },
])('refuses $case before a send with the same error and writes nothing', async ({ labels }) => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);

  fake.reply('get', terminalReply(labels));

  const checkRefusal = await caughtError(
    checkInboxTarget({ hc: runtimeOf(fake), target: 't7', family: 'answer' }),
  );

  const sendRefusal = await caughtError(
    sendInboxMessage({
      hc: runtimeOf(fake),
      target: 't7',
      family: 'answer',
      text: answerText,
      cwd: root,
    }),
  );

  expect(checkRefusal.message).toBe(sendRefusal.message);
  expect(existsSync(join(root, '.tau'))).toBe(false);
  expect(labelArguments(fake)).toEqual([]);
});

it('refuses a send when the lease names another session than expected and writes nothing', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);

  fake.reply('get', terminalReply({ 'tau.inbox': liveLease('session-2') }));

  const refusal = await caughtError(
    sendInboxMessage({
      hc: runtimeOf(fake),
      target: 't7',
      family: 'answer',
      text: answerText,
      cwd: root,
      expectedSessionId: 'session-1',
    }),
  );

  expect(refusal.message).toMatch(/session-2/);
  expect(existsSync(join(root, '.tau'))).toBe(false);
  expect(labelArguments(fake)).toEqual([]);
});

it('queues a send when the lease names the expected session', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);

  fake.reply('get', terminalReply({ 'tau.inbox': liveLease('session-1') }));
  fake.reply('label', terminalReply({}));

  await expect(
    sendInboxMessage({
      hc: runtimeOf(fake),
      target: 't7',
      family: 'answer',
      text: answerText,
      cwd: root,
      expectedSessionId: 'session-1',
    }),
  ).resolves.toMatchObject({ status: 'queued', terminal: 't7' });
});

it('names the answer tool when the sender is outside a Git checkout', async () => {
  const fake = createHcFake();
  const outside = temporaryDirectory(onTestFinished, 'tau-answer-outside-');

  fake.reply('get', terminalReply({ 'tau.inbox': liveLease('session-1') }));

  const refusal = await caughtError(
    sendInboxMessage({
      hc: runtimeOf(fake),
      target: 't7',
      family: 'answer',
      text: answerText,
      cwd: outside,
    }),
  );

  expect(refusal.message).toContain('subagent_answer');
  expect(labelArguments(fake)).toEqual([]);
});
