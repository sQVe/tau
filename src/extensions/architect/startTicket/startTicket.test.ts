import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished as onFinished } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import {
  adoptStartMarker,
  cancelStartTicket,
  createStartTicket,
  readStartEntries,
  readStartMarker,
  sweepStartFolder,
  wrapStartArgv,
} from './startTicket.js';

const run = promisify(execFile);
const leadPid = 9000;

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
  const ticket = await createStartTicket(root, token, leadPid);
  const marker = `${ticket}.started.${processId}`;

  await writeFile(marker, '');

  return marker;
};

const adoptedMarker = async (root: string, token: string, processId: number): Promise<string> => {
  const ticket = await createStartTicket(root, token, leadPid);
  const marker = `${ticket}.adopted.${processId}`;

  await writeFile(marker, '');

  return marker;
};

const startFile = async (root: string, name: string): Promise<string> => {
  const directory = join(root, '.tau', 'architect', 'start');

  await mkdir(directory, { recursive: true });

  const path = join(directory, name);

  await writeFile(path, '');

  return path;
};

it('names the marker with the process id of the exec command', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'token', leadPid);

  const argv = wrapStartArgv(ticket, ['sh', '-c', 'printf "%s" "$$"']);

  const result = await runWrapper(argv, root);

  expect(result.code).toBe(0);

  expect(await readStartMarker(root, 'token')).toEqual({
    kind: 'started',
    token: 'token',
    leadPid,
    childPid: Number(result.stdout),
    path: `${ticket}.started.${result.stdout}`,
  });
});

it('renames a started marker to adopted and tolerates a missing source', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const started = await startedMarker(root, 'token', 4100);
  const adopted = started.replace('.started.', '.adopted.');

  await adoptStartMarker(root, 'token', 4100);

  expect(existsSync(started)).toBe(false);

  expect(await readStartMarker(root, 'token')).toEqual({
    kind: 'adopted',
    token: 'token',
    leadPid,
    childPid: 4100,
    path: adopted,
  });

  await expect(adoptStartMarker(root, 'token', 4100)).resolves.toBeUndefined();
  expect(existsSync(adopted)).toBe(true);
});

it('runs no command on a second run and exits 75', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'token', leadPid);
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
  const ticket = await createStartTicket(root, 'token', leadPid);

  const argv = wrapStartArgv(ticket, ['printf', '<%s>\n', 'a b', 'c"d', 'e f']);

  const result = await runWrapper(argv, root);

  expect(result.code).toBe(0);
  expect(result.stdout).toBe('<a b>\n<c"d>\n<e f>\n');
  const marker = await readStartMarker(root, 'token');

  expect(marker?.kind).toBe('started');

  expect(
    (await markerNames(root)).some((name) => name.startsWith(`token.lead.${leadPid}.started.`)),
  ).toBe(true);
});

it('sweeps an unused ticket from a gone claim by cancelling it', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const ticket = await createStartTicket(root, 'gone', leadPid);

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
  const ticket = await createStartTicket(root, 'gone', leadPid);
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

it('deletes an adopted marker whose process is gone and starts', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const marker = await adoptedMarker(root, 'gone', 4005);

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'gone',
  });

  expect(outcome).toEqual({ kind: 'clear' });
  expect(existsSync(marker)).toBe(false);
});

it('leaves an adopted marker whose process runs and starts', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const marker = await adoptedMarker(root, 'gone', 4006);

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'running',
  });

  expect(outcome).toEqual({ kind: 'clear' });
  expect(existsSync(marker)).toBe(true);
});

it('leaves an adopted marker whose process state is unknown and starts', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const marker = await adoptedMarker(root, 'gone', 4007);

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'unknown',
  });

  expect(outcome).toEqual({ kind: 'clear' });
  expect(existsSync(marker)).toBe(true);
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
  const ticket = await createStartTicket(root, 'gone', leadPid);
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
  const ticket = await createStartTicket(root, 'gone', leadPid);
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
  const ticket = await createStartTicket(root, 'current', leadPid);

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
  const ticket = await createStartTicket(root, 'gone', leadPid);

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
  const ticket = await createStartTicket(root, 'gone', leadPid);
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

it.each([
  { name: 'a cancelled marker with a started name', fileName: 'old-token.started.cancelled' },
  { name: 'a lone started marker', fileName: '.started' },
])('refuses $fileName as a malformed start marker', async ({ fileName }) => {
  const root = await createTemporaryRepository(onFinished);
  const marker = await startFile(root, fileName);

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'gone',
  });

  expect(outcome).toEqual({ kind: 'refuseMalformed', path: marker });
  expect(existsSync(marker)).toBe(true);
});

it('refuses a malformed marker when a valid marker exists for the same token', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const adopted = await startFile(root, 'old-token.lead.9000.adopted.4100');
  const malformed = await startFile(root, 'old-token.lead.9000.started.bad');
  const names = await markerNames(root);

  expect(names.indexOf('old-token.lead.9000.adopted.4100')).toBeLessThan(
    names.indexOf('old-token.lead.9000.started.bad'),
  );

  const outcome = await sweepStartFolder({
    root,
    currentToken: 'current',
    stateOf: () => 'gone',
  });

  expect(outcome).toEqual({ kind: 'refuseMalformed', path: malformed });
  expect(existsSync(adopted)).toBe(true);
  expect(existsSync(malformed)).toBe(true);
});

it.each([
  {
    name: 'a ticket',
    fileName: 'token.lead.9000',
    expected: { kind: 'unused', token: 'token' },
  },
  {
    name: 'a started marker',
    fileName: 'token.lead.9000.started.4100',
    expected: { kind: 'marker', token: 'token', markerKind: 'started' },
  },
  {
    name: 'an adopted marker',
    fileName: 'token.lead.9000.adopted.4100',
    expected: { kind: 'marker', token: 'token', markerKind: 'adopted' },
  },
  {
    name: 'a bare ticket from an older start',
    fileName: 'token',
    expected: { kind: 'unused', token: 'token' },
  },
])('parses $name', async ({ fileName, expected }) => {
  const root = await createTemporaryRepository(onFinished);
  const path = await startFile(root, fileName);
  const entries = await readStartEntries(root);

  const expectedEntry =
    'markerKind' in expected
      ? { kind: expected.kind, token: expected.token, marker: { kind: expected.markerKind, path } }
      : { kind: expected.kind, token: expected.token };

  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject(expectedEntry);
});

it('parses a cancelled ticket name', async () => {
  const root = await createTemporaryRepository(onFinished);

  await startFile(root, 'token.lead.9000.cancelled');

  expect(await readStartEntries(root)).toEqual([]);
});

it.each([
  'token.lead.9000.started',
  'token.lead.9000.started.bad',
  'token.lead.bad.started.4100',
  'token.started.4100',
  'token.lead.9000.started.4100.cancelled',
  'token.lead.9000.other',
])('rejects %s as a malformed marker', async (fileName) => {
  const root = await createTemporaryRepository(onFinished);
  const path = await startFile(root, fileName);
  const entries = await readStartEntries(root);

  expect(entries).toHaveLength(1);

  expect(entries[0]).toMatchObject({
    kind: 'marker',
    marker: { kind: 'malformed', path },
  });
});
