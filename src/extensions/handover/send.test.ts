import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { startHandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import type { Exec } from '../../command.js';
import type { HcRuntime } from '../../hc/hc.js';
import { sendHandover } from './send.js';

const callerAddress = 'caller';

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

const terminalReply = (address: string, name: string | null = null, path = '/tmp/none.sock') =>
  JSON.stringify({ address, name, state: 'live', labels: { 'tau.inbox': `rpc1:${path}` } });

const socketRoot = (): string => {
  const root = mkdtempSync('/tmp/tau-handover-');

  chmodSync(root, 0o700);

  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  return root;
};

const refusal = 'Nothing was queued. Use handover start to open a receiver instead.';

const writeHandover = async (root: string, content: string): Promise<string> => {
  const directory = join(root, '.tau', 'handovers');
  const file = join(directory, 'message.md');

  await mkdir(directory, { recursive: true });
  await writeFile(file, content);

  return file;
};

const expectNoSend = (fake: HcFake) => {
  expect(fake.calls.map((call) => call.commandArguments[0])).not.toContain('send');
};

it('sends the file text to the receiver inbox and returns queued with its message ID', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const receiver = await startHandoverReceiver(onTestFinished, socketRoot(), 't7');

  fake.reply('get', terminalReply('t7', null, receiver.path));

  const result = await sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file });

  expect(result).toMatchObject({ status: 'queued', terminal: 't7', sessionId: receiver.sessionId });
  expect(receiver.savedRecords()).toContain(join(receiver.sessionId, `${result.messageId}.json`));
  expectNoSend(fake);
});

it('keeps the message ID of a retry, so the receiver saves the message once', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const receiver = await startHandoverReceiver(onTestFinished, socketRoot(), 't7');
  const messageId = '11111111-1111-4111-8111-111111111111';
  const request = { cwd: root, terminal: 't7', file, messageId };

  fake.reply('get', terminalReply('t7', null, receiver.path));

  await expect(sendHandover(runtimeOf(fake), request)).resolves.toMatchObject({ messageId });

  await expect(sendHandover(runtimeOf(fake), request)).resolves.toMatchObject({
    status: 'queued',
    messageId,
  });

  expect(receiver.savedRecords()).toEqual([
    receiver.sessionId,
    join(receiver.sessionId, `${messageId}.json`),
  ]);
});

it('returns unknown when the receiver closes without a reply, and a retry with that ID queues once', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const sockets = socketRoot();
  const receiver = await startHandoverReceiver(onTestFinished, sockets, 't7');

  // The receiver cannot create its record directory, so it closes the connection without a reply.
  writeFileSync(join(sockets, 'records'), '');
  fake.reply('get', terminalReply('t7', null, receiver.path));

  const lost = await sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file });

  expect(lost).toMatchObject({ status: 'unknown', terminal: 't7', sessionId: receiver.sessionId });
  expect(lost.note).toContain(`A retry must reuse this message ID and the same text.`);

  rmSync(join(sockets, 'records'));

  const retry = { cwd: root, terminal: 't7', file, messageId: lost.messageId };

  await expect(sendHandover(runtimeOf(fake), retry)).resolves.toMatchObject({
    status: 'queued',
    messageId: lost.messageId,
  });

  expect(receiver.savedRecords()).toEqual([
    receiver.sessionId,
    join(receiver.sessionId, `${lost.messageId}.json`),
  ]);
});

it('refuses a retry ID that is not a UUID before any hc call', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  await expect(
    sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file, messageId: 'retry' }),
  ).rejects.toThrow(`The message ID is not a UUID: retry ${refusal}`);

  expect(fake.calls).toEqual([]);
});

it('refuses a file larger than the handover limit without sending', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'x'.repeat(102_401));

  await expect(sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file })).rejects.toThrow(
    /handover file is larger than 102400 bytes/,
  );

  expect(fake.calls).toEqual([]);
});

it('refuses a file outside the handovers directory without sending', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = join(root, 'outside.md');

  await writeFile(file, 'Next steps\n');
  fake.reply('get', terminalReply('t7'));

  await expect(sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file })).rejects.toThrow(
    /outside the .tau\/handovers directory/,
  );

  expectNoSend(fake);
});

it('refuses a symlink that leaves the handovers directory without sending', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const outside = join(root, 'outside.md');
  const link = join(root, '.tau', 'handovers', 'linked.md');

  await writeFile(outside, 'Next steps\n');
  await mkdir(join(root, '.tau', 'handovers'), { recursive: true });
  await symlink(outside, link, 'file');
  fake.reply('get', terminalReply('t7'));

  await expect(
    sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file: link }),
  ).rejects.toThrow(/outside the .tau\/handovers directory/);

  expectNoSend(fake);
});

it('refuses an empty file without sending', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, '');

  fake.reply('get', terminalReply('t7'));

  await expect(sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file })).rejects.toThrow(
    /is empty/,
  );

  expectNoSend(fake);
});

it('refuses a missing file without sending', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = join(root, '.tau', 'handovers', 'absent.md');

  await mkdir(join(root, '.tau', 'handovers'), { recursive: true });
  fake.reply('get', terminalReply('t7'));

  await expect(sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file })).rejects.toThrow(
    /does not exist/,
  );

  expectNoSend(fake);
});

it("refuses the caller's own terminal by address without sending", async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  fake.reply('get', terminalReply(callerAddress, 'worker'));

  await expect(
    sendHandover(runtimeOf(fake), { cwd: root, terminal: callerAddress, file }),
  ).rejects.toThrow(`own terminal. ${refusal}`);

  expectNoSend(fake);
});

it("refuses the caller's own terminal by name without sending", async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  fake.reply('get', terminalReply(callerAddress, 'worker'));

  await expect(
    sendHandover(runtimeOf(fake), { cwd: root, terminal: 'worker', file }),
  ).rejects.toThrow(`own terminal. ${refusal}`);

  expectNoSend(fake);
});

it('sends nothing when the caller aborts while the terminal lookup is pending', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const controller = new AbortController();

  const exec: Exec = async (command, commandArguments, options) => {
    const result = await fake.exec(command, commandArguments, options);

    if (commandArguments[0] === 'get') {
      controller.abort();
    }

    return result;
  };

  fake.reply('get', terminalReply('t7'));
  const runtime = { exec, connect: fake.connect, cwd: '/repository', signal: controller.signal };

  await expect(sendHandover(runtime, { cwd: root, terminal: 't7', file })).rejects.toMatchObject({
    name: 'AbortError',
  });

  expectNoSend(fake);
});
