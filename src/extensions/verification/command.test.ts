import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { groupState } from '../../process/process.js';
import { runCommand } from './command.js';
import type { CommandOptions } from './command.js';

const temporaryCommandDirectory = (): string => temporaryDirectory(onTestFinished, 'tau-command-');

const optionsIn = (cwd: string, overrides: Partial<CommandOptions> = {}): CommandOptions => ({
  argv: ['sh', '-c', 'true'],
  cwd,
  logPath: join(cwd, 'command.log'),
  environment: {},
  deadlineMilliseconds: 5000,
  signal: undefined,
  ...overrides,
});

const readGroupId = async (path: string): Promise<number> => {
  const text = await readFile(path, 'utf8');

  return Number(text.trim());
};

const waitForGroupId = async (path: string): Promise<number> => {
  while (!existsSync(path)) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  return readGroupId(path);
};

const killGroupInCleanup = (groupId: number): void => {
  onTestFinished(() => {
    try {
      process.kill(-groupId, 'SIGKILL');
    } catch {
      // The group has already stopped.
    }
  });
};

it('passes the extra environment to the command', async () => {
  const cwd = temporaryCommandDirectory();

  const outcome = await runCommand(
    optionsIn(cwd, {
      argv: ['sh', '-c', 'printf %s "$TAU_EXAMPLE" > out'],
      environment: { TAU_EXAMPLE: 'value' },
    }),
  );

  expect(outcome).toEqual({ kind: 'exited', exitCode: 0 });
  expect(await readFile(join(cwd, 'out'), 'utf8')).toBe('value');
});

it('returns the exit code and keeps the output in the log', async () => {
  const cwd = temporaryCommandDirectory();

  const outcome = await runCommand(optionsIn(cwd, { argv: ['sh', '-c', 'echo hello; exit 3'] }));

  expect(outcome).toEqual({ kind: 'exited', exitCode: 3 });
  expect(await readFile(join(cwd, 'command.log'), 'utf8')).toContain('hello');
});

it('leaves a background process running after a normal exit', async () => {
  const cwd = temporaryCommandDirectory();
  const groupPath = join(cwd, 'group');

  const outcome = await runCommand(
    optionsIn(cwd, { argv: ['sh', '-c', 'echo $$ > group; sleep 30 & exit 0'] }),
  );

  const groupId = await readGroupId(groupPath);

  killGroupInCleanup(groupId);

  expect(outcome).toEqual({ kind: 'exited', exitCode: 0 });
  expect(await groupState(groupId)).not.toBe('gone');
});

it('stops the process group at the deadline', async () => {
  const cwd = temporaryCommandDirectory();
  const groupPath = join(cwd, 'group');

  const outcome = await runCommand(
    optionsIn(cwd, {
      argv: ['sh', '-c', 'echo $$ > group; sleep 30 & wait'],
      deadlineMilliseconds: 200,
    }),
  );

  const groupId = await readGroupId(groupPath);

  killGroupInCleanup(groupId);

  expect(outcome).toEqual({ kind: 'stopped', reason: 'deadline' });
  expect(await groupState(groupId)).toBe('gone');
});

it('stops the process group on cancel', async () => {
  const cwd = temporaryCommandDirectory();
  const groupPath = join(cwd, 'group');
  const controller = new AbortController();

  const outcome = runCommand(
    optionsIn(cwd, {
      argv: ['sh', '-c', 'echo $$ > group; sleep 30 & wait'],
      signal: controller.signal,
    }),
  );

  const groupId = await waitForGroupId(groupPath);

  killGroupInCleanup(groupId);
  controller.abort();

  expect(await outcome).toEqual({ kind: 'stopped', reason: 'cancelled' });
  expect(await groupState(groupId)).toBe('gone');
});

it('reports a command killed by a signal', async () => {
  const cwd = temporaryCommandDirectory();

  const outcome = await runCommand(optionsIn(cwd, { argv: ['sh', '-c', 'kill -TERM $$'] }));

  expect(outcome).toEqual({ kind: 'signalled', signal: 'SIGTERM' });
});

it('reports a command that cannot start', async () => {
  const cwd = temporaryCommandDirectory();
  const executable = 'tau-command-that-does-not-exist';

  const outcome = await runCommand(optionsIn(cwd, { argv: [executable] }));

  expect(outcome).toMatchObject({ kind: 'notStarted' });
  expect(await readFile(join(cwd, 'command.log'), 'utf8')).toContain(executable);
});

it('refuses an invalid deadline or an empty argv', async () => {
  const cwd = temporaryCommandDirectory();

  const cases = [
    { deadlineMilliseconds: 0, message: 'got 0.' },
    { deadlineMilliseconds: -1, message: 'got -1.' },
    { deadlineMilliseconds: Infinity, message: 'got Infinity.' },
    { deadlineMilliseconds: 1.5, message: 'got 1.5.' },
    { deadlineMilliseconds: 2_147_483_648, message: 'got 2147483648.' },
  ];

  for (const { deadlineMilliseconds, message } of cases) {
    const logPath = join(cwd, `deadline-${deadlineMilliseconds}.log`);

    await expect(runCommand(optionsIn(cwd, { deadlineMilliseconds, logPath }))).rejects.toThrow(
      message,
    );

    expect(existsSync(logPath)).toBe(false);
  }

  const logPath = join(cwd, 'empty-argv.log');

  await expect(runCommand(optionsIn(cwd, { argv: [], logPath }))).rejects.toThrow(
    'A command needs at least one argument.',
  );

  expect(existsSync(logPath)).toBe(false);
});

it('accepts the largest timer delay', async () => {
  const cwd = temporaryCommandDirectory();

  const outcome = await runCommand(
    optionsIn(cwd, { argv: ['sh', '-c', 'true'], deadlineMilliseconds: 2_147_483_647 }),
  );

  expect(outcome).toEqual({ kind: 'exited', exitCode: 0 });
});
