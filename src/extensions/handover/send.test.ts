import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
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

const terminalReply = (address: string, name: string | null = null): string =>
  JSON.stringify({ address, name, state: 'live', labels: {} });

const writeHandover = async (root: string, content: string): Promise<string> => {
  const directory = join(root, '.tau', 'handovers');
  const file = join(directory, 'message.md');

  await mkdir(directory, { recursive: true });
  await writeFile(file, content);

  return file;
};

const sendArguments = (fake: HcFake): string[][] =>
  fake.calls
    .filter((call) => call.commandArguments[0] === 'send')
    .map((call) => call.commandArguments);

const expectNoSend = (fake: HcFake) => {
  expect(sendArguments(fake)).toEqual([]);
};

const expectNoForceOrWait = (fake: HcFake) => {
  for (const argument of sendArguments(fake).flat()) {
    expect(['--force', '--wait']).not.toContain(argument);
  }
};

it('sends the file text with no force or wait and reports started', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  fake.reply('get', terminalReply('t7'));
  fake.reply('send', JSON.stringify({ turn: 3, started: true }));

  const result = await sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file });

  expect(result).toEqual({ status: 'started', terminal: 't7', turn: 3 });
  expect(sendArguments(fake)).toEqual([['send', '--json', '--', 't7', 'Next steps\n']]);
  expectNoForceOrWait(fake);
});

it.each([
  { name: 'false', started: false },
  { name: 'null', started: null },
])('reports notStarted when the reply has started $name', async ({ started }) => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  fake.reply('get', terminalReply('t7'));
  fake.reply('send', JSON.stringify({ turn: 4, started }));

  const result = await sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file });

  expect(result).toEqual({ status: 'notStarted', terminal: 't7', turn: 4 });
  expectNoForceOrWait(fake);
});

it('reports notStarted when the reply has no started field', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  fake.reply('get', terminalReply('t7'));
  fake.reply('send', JSON.stringify({ turn: 5 }));

  const result = await sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file });

  expect(result).toEqual({ status: 'notStarted', terminal: 't7', turn: 5 });
  expectNoForceOrWait(fake);
});

it('reports blocked without a turn when hc exits with the blocked error', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  const blocked = JSON.stringify({
    error: { kind: 'blocked', message: 'the terminal is busy' },
  });

  fake.reply('get', terminalReply('t7'));
  fake.fail('send', blocked, 9);

  const result = await sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file });

  expect(result).toEqual({ status: 'blocked', terminal: 't7' });
  expect(sendArguments(fake)).toHaveLength(1);
  expectNoForceOrWait(fake);
});

it('rethrows other hc errors from the send', async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const notFound = JSON.stringify({ error: { kind: 'not_found', message: 'gone' } });

  fake.reply('get', terminalReply('t7'));
  fake.fail('send', notFound, 2);

  await expect(sendHandover(runtimeOf(fake), { cwd: root, terminal: 't7', file })).rejects.toThrow(
    'gone',
  );

  expect(sendArguments(fake)).toHaveLength(1);
  expectNoForceOrWait(fake);
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
  ).rejects.toThrow(/own terminal/);

  expectNoSend(fake);
});

it("refuses the caller's own terminal by name without sending", async () => {
  const fake = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  fake.reply('get', terminalReply(callerAddress, 'worker'));

  await expect(
    sendHandover(runtimeOf(fake), { cwd: root, terminal: 'worker', file }),
  ).rejects.toThrow(/own terminal/);

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
  fake.reply('send', JSON.stringify({ turn: 3, started: true }));

  const runtime = { exec, connect: fake.connect, cwd: '/repository', signal: controller.signal };

  await expect(sendHandover(runtime, { cwd: root, terminal: 't7', file })).rejects.toMatchObject({
    name: 'AbortError',
  });

  expectNoSend(fake);
});
