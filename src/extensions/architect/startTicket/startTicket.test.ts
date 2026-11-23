import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import {
  cancelStartTicket,
  createStartTicket,
  readStartEntries,
  sweepStartFolder,
  wrapStartArgv,
} from './startTicket.js';

const run = promisify(execFile);

const runWrapper = async (
  argv: string[],
  cwd: string,
): Promise<{ code: number; stdout: string }> => {
  try {
    const { stdout } = await run('sh', argv.slice(1), { cwd });

    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };

    return { code: failure.code ?? -1, stdout: failure.stdout ?? '' };
  }
};

it('passes arguments with a space and a double quote through unchanged', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'token');

  const argv = wrapStartArgv(ticket, ['printf', '<%s>\n', 'a b', 'c"d', 'e f']);

  const result = await runWrapper(argv, root);

  expect(result.code).toBe(0);
  expect(result.stdout).toBe('<a b>\n<c"d>\n<e f>\n');
  expect(existsSync(`${ticket}.started`)).toBe(true);
});

it('runs no command after the caller cancelled the ticket and exits 75', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'token');
  const ran = join(root, 'ran.txt');
  const argv = wrapStartArgv(ticket, ['sh', '-c', `printf ran > ${ran}`]);

  expect(await cancelStartTicket(ticket)).toBe('cancelled');

  const result = await runWrapper(argv, root);

  expect(result.code).toBe(75);
  expect(existsSync(ran)).toBe(false);
});

it('reports taken when the child already renamed the ticket', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'token');
  const argv = wrapStartArgv(ticket, ['sh', '-c', 'exit 0']);

  const result = await runWrapper(argv, root);

  expect(result.code).toBe(0);
  expect(existsSync(`${ticket}.started`)).toBe(true);
  expect(await cancelStartTicket(ticket)).toBe('taken');
});

it('sweeps an unused ticket from a gone claim by cancelling it', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'gone');

  expect(await readStartEntries(root)).toEqual([
    { token: 'gone', ticket, marker: 'unused', markerPath: `${ticket}.started` },
  ]);

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    terminalOf: () => Promise.resolve('live'),
  });

  expect(outcome).toBe('clear');
  expect(existsSync(ticket)).toBe(false);
});

it('refuses to start while another claim has a started marker and a live terminal', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'gone');

  await writeFile(`${ticket}.started`, '');

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    terminalOf: () => Promise.resolve('live'),
  });

  expect(outcome).toBe('starting');
  expect(existsSync(`${ticket}.started`)).toBe(true);
});

it('deletes a started marker whose terminal ended', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'gone');

  await writeFile(`${ticket}.started`, '');

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    terminalOf: () => Promise.resolve('ended'),
  });

  expect(outcome).toBe('clear');
  expect(existsSync(`${ticket}.started`)).toBe(false);
});

it('keeps a started marker whose terminal could not be read', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'gone');

  await writeFile(`${ticket}.started`, '');

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    terminalOf: () => Promise.resolve('unread'),
  });

  expect(outcome).toBe('starting');
  expect(existsSync(`${ticket}.started`)).toBe(true);
});

it('does not sweep its own ticket', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'current');

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    terminalOf: () => Promise.resolve('none'),
  });

  expect(outcome).toBe('clear');
  expect(existsSync(ticket)).toBe(true);
  expect(await readFile(ticket, 'utf8')).toBe('');
});

it('ignores a cancelled ticket file when it sweeps', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'gone');

  expect(await cancelStartTicket(ticket)).toBe('cancelled');
  await writeFile(`${ticket}.cancelled`, '');

  expect(await readStartEntries(root)).toEqual([]);

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    terminalOf: () => Promise.resolve('none'),
  });

  expect(outcome).toBe('clear');
});
