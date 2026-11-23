import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import {
  cancelStartTicket,
  createStartTicket,
  readStartEntries,
  readStartMarker,
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

const markerNames = async (root: string): Promise<string[]> =>
  readdir(join(root, '.tau', 'architect', 'start'));

const startedMarker = async (root: string, token: string, processId: number): Promise<string> => {
  const ticket = await createStartTicket(root, token);
  const marker = `${ticket}.started.${processId}`;

  await writeFile(marker, '');

  return marker;
};

it('names the marker with the process id of the exec command', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'token');

  const argv = wrapStartArgv(ticket, ['sh', '-c', 'printf "%s" "$$"']);

  const result = await runWrapper(argv, root);

  expect(result.code).toBe(0);

  expect(await readStartMarker(root, 'token')).toEqual({
    kind: 'process',
    pid: Number(result.stdout),
    path: `${ticket}.started.${result.stdout}`,
  });
});

it('runs no command on a second run and exits 75', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'token');
  const first = join(root, 'first.txt');
  const second = join(root, 'second.txt');

  expect(
    await runWrapper(wrapStartArgv(ticket, ['sh', '-c', `printf first > ${first}`]), root),
  ).toMatchObject({ code: 0 });

  expect(existsSync(first)).toBe(true);

  const result = await runWrapper(
    wrapStartArgv(ticket, ['sh', '-c', `printf second > ${second}`]),
    root,
  );

  expect(result.code).toBe(75);
  expect(existsSync(second)).toBe(false);
});

it('passes arguments with a space and a double quote through unchanged', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'token');

  const argv = wrapStartArgv(ticket, ['printf', '<%s>\n', 'a b', 'c"d', 'e f']);

  const result = await runWrapper(argv, root);

  expect(result.code).toBe(0);
  expect(result.stdout).toBe('<a b>\n<c"d>\n<e f>\n');
  const marker = await readStartMarker(root, 'token');

  expect(marker?.kind).toBe('process');
  expect((await markerNames(root)).some((name) => name.startsWith('token.started.'))).toBe(true);
});

it('sweeps an unused ticket from a gone claim by cancelling it', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'gone');

  expect(await readStartEntries(root)).toEqual([{ kind: 'unused', token: 'gone', ticket }]);

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'running',
  });

  expect(outcome).toEqual({ kind: 'clear' });
  expect(existsSync(ticket)).toBe(false);
});

it('refuses a ticket taken after its claim ended and names the process id', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'gone');
  const marker = `${ticket}.started.4004`;

  await rename(ticket, marker);

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'running',
  });

  expect(outcome).toEqual({ kind: 'refuseRunning', processId: 4004 });
  expect(existsSync(marker)).toBe(true);
});

it('deletes a started marker whose process is gone and starts', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const marker = await startedMarker(root, 'gone', 4001);

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'gone',
  });

  expect(outcome).toEqual({ kind: 'clear' });
  expect(existsSync(marker)).toBe(false);
});

it('refuses a started marker whose process runs and names the process id', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const marker = await startedMarker(root, 'gone', 4002);

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'running',
  });

  expect(outcome).toEqual({ kind: 'refuseRunning', processId: 4002 });
  expect(existsSync(marker)).toBe(true);
});

it('refuses a started marker whose process state is unknown and keeps the marker', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const marker = await startedMarker(root, 'gone', 4003);

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'unknown',
  });

  expect(outcome).toEqual({ kind: 'refuseRunning', processId: 4003 });
  expect(existsSync(marker)).toBe(true);
});

it('refuses a marker name without a process id and names the path', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'gone');
  const marker = `${ticket}.started`;

  await writeFile(marker, '');

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'gone',
  });

  expect(outcome).toEqual({ kind: 'refuseMalformed', path: marker });
  expect(existsSync(marker)).toBe(true);
});

it('refuses a marker name with an invalid process id and names the path', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'gone');
  const marker = `${ticket}.started.not-a-pid`;

  await writeFile(marker, '');

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'gone',
  });

  expect(outcome).toEqual({ kind: 'refuseMalformed', path: marker });
  expect(existsSync(marker)).toBe(true);
});

it('does not sweep its own ticket', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'current');

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'running',
  });

  expect(outcome).toEqual({ kind: 'clear' });
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
    stateOf: () => 'running',
  });

  expect(outcome).toEqual({ kind: 'clear' });
});

it('refuses an unrecognised started name and names the path', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'gone');
  const marker = `${ticket}.started-other`;

  await rename(ticket, marker);

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'gone',
  });

  expect(outcome).toEqual({ kind: 'refuseMalformed', path: marker });
  expect(existsSync(marker)).toBe(true);
});
