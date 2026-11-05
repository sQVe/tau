import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import type { Exec } from '../../command.js';
import { isMissingFile } from '../../errors.js';
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

const terminalReply = (address: string, name: string | null = null): string =>
  JSON.stringify({ address, name, state: 'live', labels: {} });

const writeHandover = async (root: string, content: string): Promise<string> => {
  const directory = join(root, '.tau', 'handovers');
  const file = join(directory, 'message.md');

  await mkdir(directory, { recursive: true });
  await writeFile(file, content);

  return file;
};

const leasedReply = (address: string, lease: string): string =>
  JSON.stringify({ address, name: null, state: 'live', labels: { 'tau.inbox': lease } });

const liveLease = (): string => `session-1:${Date.now() + 60_000}`;

const argumentsOf = (fake: HcFake, command: string): string[][] =>
  fake.calls
    .filter((call) => call.commandArguments[0] === command)
    .map((call) => call.commandArguments);

const inboxFiles = async (root: string): Promise<string[]> => {
  try {
    return await readdir(join(root, '.tau', 'inbox'));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

const expectNothingQueued = async (fake: HcFake, root: string) => {
  expect(await inboxFiles(root)).toEqual([]);
  expect(argumentsOf(fake, 'label')).toEqual([]);
  expect(argumentsOf(fake, 'send')).toEqual([]);
};

it('queues the file text in the inbox of a receiver with a live lease', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  fake.reply('get', leasedReply('t7', liveLease()));
  fake.reply('label', terminalReply('t7'));

  const result = await sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file });

  expect(result).toMatchObject({ status: 'queued', terminal: 't7' });
  expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);

  const envelopePath = join(root, '.tau', 'inbox', `${result.messageId}.json`);
  const envelope = JSON.parse(await readFile(envelopePath, 'utf8')) as Record<string, unknown>;

  expect(await inboxFiles(root)).toEqual([`${result.messageId}.json`]);

  expect(envelope).toMatchObject({
    family: 'handover',
    targetTerminal: 't7',
    text: 'Next steps\n',
  });

  expect(argumentsOf(fake, 'label')).toEqual([
    ['label', '--json', '--', 't7', `tau.inbox.${result.messageId}=${envelopePath}`],
  ]);

  expect(argumentsOf(fake, 'send')).toEqual([]);
});

it.each([
  { name: 'no lease', reply: () => terminalReply('t7') },
  { name: 'an expired lease', reply: () => leasedReply('t7', `session-1:${Date.now() - 1}`) },
])('refuses a receiver with $name and queues nothing', async ({ reply }) => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  fake.reply('get', reply());

  await expect(sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file })).rejects.toThrow(
    /handover start/,
  );

  await expectNothingQueued(fake, root);
});

it('refuses a receiver on another machine and queues nothing', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  fake.reply('get', leasedReply('machine/t7', liveLease()));

  await expect(
    sendHandover(runtimeOf(fake), { cwd: root, terminal: 'machine/t7', file }),
  ).rejects.toThrow(/another machine.*handover start/);

  await expectNothingQueued(fake, root);
});

it('refuses a file outside the handovers directory and queues nothing', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = join(root, 'outside.md');

  await writeFile(file, 'Next steps\n');
  fake.reply('get', terminalReply('t7'));

  await expect(sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file })).rejects.toThrow(
    /outside the .tau\/handovers directory/,
  );

  await expectNothingQueued(fake, root);
});

it('refuses a symlink that leaves the handovers directory and queues nothing', async () => {
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

  await expectNothingQueued(fake, root);
});

it('refuses an empty file and queues nothing', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, '');

  fake.reply('get', terminalReply('t7'));

  await expect(sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file })).rejects.toThrow(
    /is empty/,
  );

  await expectNothingQueued(fake, root);
});

it('refuses a missing file and queues nothing', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = join(root, '.tau', 'handovers', 'absent.md');

  await mkdir(join(root, '.tau', 'handovers'), { recursive: true });
  fake.reply('get', terminalReply('t7'));

  await expect(sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file })).rejects.toThrow(
    /does not exist/,
  );

  await expectNothingQueued(fake, root);
});

it("refuses the caller's own terminal by address and queues nothing", async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  fake.reply('get', terminalReply(callerAddress, 'worker'));

  await expect(
    sendHandover(runtimeOf(fake), { cwd: root, terminal: callerAddress, file }),
  ).rejects.toThrow(/own terminal.*handover start/);

  await expectNothingQueued(fake, root);
});

it("refuses the caller's own terminal by name and queues nothing", async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  fake.reply('get', terminalReply(callerAddress, 'worker'));

  await expect(
    sendHandover(runtimeOf(fake), { cwd: root, terminal: 'worker', file }),
  ).rejects.toThrow(/own terminal.*handover start/);

  await expectNothingQueued(fake, root);
});

it('queues nothing when the caller aborts while the terminal lookup is pending', async () => {
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

  fake.reply('get', leasedReply('t7', liveLease()));
  fake.reply('label', terminalReply('t7'));

  const runtime = { exec, connect: fake.connect, cwd: '/repository', signal: controller.signal };

  await expect(sendHandover(runtime, { cwd: root, terminal: 't7', file })).rejects.toMatchObject({
    name: 'AbortError',
  });

  await expectNothingQueued(fake, root);
});
