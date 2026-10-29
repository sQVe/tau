import { execFile, spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished, vi } from 'vitest';

import { declinedExec } from '../../../tests/declinedExecFake.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { defaultLockPath } from './queue.js';
import { createFullCheckTool } from './tool.js';

const recorderSource = `
const { appendFileSync } = require('node:fs');
const [record, name] = process.argv.slice(2);
appendFileSync(record, 'start ' + name + '\\n');
setTimeout(() => {
  appendFileSync(record, 'end ' + name + '\\n');
}, 300);
`;

// Records its start, then waits for every file in `gates` to exist. Exits with an error after a
// bounded wait, so a command that is never released fails the test instead of hanging it.
const gatedSource = `
const { appendFileSync, existsSync } = require('node:fs');
const [record, name, ...gates] = process.argv.slice(2);
appendFileSync(record, 'start ' + name + '\\n');
const deadline = Date.now() + 5000;
const timer = setInterval(() => {
  if (gates.every((gate) => existsSync(gate))) {
    clearInterval(timer);
    appendFileSync(record, 'end ' + name + '\\n');
  } else if (Date.now() > deadline) {
    process.exit(1);
  }
}, 10);
`;

const fixture = async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-full-check-');

  const agentDirectory = join(directory, 'agent');
  const record = join(directory, 'record.txt');
  const script = join(directory, 'recorder.cjs');

  const gated = join(directory, 'gated.cjs');
  const release = join(directory, 'release');

  await mkdir(agentDirectory);
  await writeFile(script, recorderSource);
  await writeFile(gated, gatedSource);

  return { agentDirectory, directory, record, script, gated, release };
};

const lockPathFor = (agentDirectory: string, repository = 'owner/first') =>
  defaultLockPath(agentDirectory, repository);

const repositoryNamed = async (name: string, remote = `git@github.com:owner/${name}.git`) => {
  const root = await createTemporaryRepository(onTestFinished, `tau-full-check-${name}-`);

  await promisify(execFile)('git', ['remote', 'add', 'origin', remote], {
    cwd: root,
  });

  await promisify(execFile)(
    'git',
    [
      '-c',
      'user.name=Tau',
      '-c',
      'user.email=tau@example.com',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'first',
    ],
    { cwd: root },
  );

  return root;
};

const writeRepositoryFile = async (root: string, value: unknown) => {
  await mkdir(join(root, '.pi'), { recursive: true });
  await writeFile(join(root, '.pi', 'tau.json'), JSON.stringify(value));
};

const configure = (root: string, argv: string[]) =>
  writeRepositoryFile(root, { fullCheck: { argv } });

// Lists the lock files whose owner has not released them.
const heldLocks = async (agentDirectory: string) => {
  const directory = join(agentDirectory, 'tau', 'full-check');

  const names = await readdir(directory).catch(() => []);
  const held: string[] = [];

  for (const name of names.filter((entry) => /\.\d+$/u.test(entry))) {
    const owner = JSON.parse(await readFile(join(directory, name), 'utf8')) as {
      released?: boolean;
    };

    if (owner.released !== true) {
      held.push(name);
    }
  }

  return held;
};

const contextFor = (cwd: string) =>
  ({ cwd, isProjectTrusted: () => true, ui: { notify: () => undefined } }) as never;

const runTool = async (
  agentDirectory: string,
  cwd: string,
  signal?: AbortSignal,
  updates: string[] = [],
) => {
  const result = await createFullCheckTool({
    agentDirectory,
    exec: declinedExec,
    pollMilliseconds: 10,
  }).execute(
    'call',
    {},
    signal,
    (update) => {
      const [block] = update.content;
      updates.push(block?.type === 'text' ? block.text : '');
    },
    contextFor(cwd),
  );

  return { result, updates };
};

const readLines = async (record: string) => (await readFile(record, 'utf8')).trim().split('\n');

const waitForLine = (record: string, line: string) =>
  vi.waitFor(
    async () => {
      expect(await readFile(record, 'utf8').catch(() => '')).toContain(line);
    },
    { timeout: 4000 },
  );

it('runs full checks of different repositories at once without a wait', async () => {
  const { agentDirectory, directory, record, gated } = await fixture();
  const first = await repositoryNamed('first');
  const second = await repositoryNamed('second');
  const startedFirst = join(directory, 'started-first');
  const startedSecond = join(directory, 'started-second');

  // Each command ends only after both have started, so they must overlap.
  await configure(first, [process.execPath, gated, record, 'first', startedFirst, startedSecond]);
  await configure(second, [process.execPath, gated, record, 'second', startedFirst, startedSecond]);

  const firstRun = runTool(agentDirectory, first);
  await waitForLine(record, 'start first');
  const secondRun = runTool(agentDirectory, second);
  await waitForLine(record, 'start second');

  await writeFile(startedFirst, '');
  await writeFile(startedSecond, '');

  const [firstDone, secondDone] = await Promise.all([firstRun, secondRun]);

  expect(firstDone.updates).toEqual([]);
  expect(secondDone.updates).toEqual([]);
  expect(firstDone.result.details?.passed).toBe(true);
  expect(secondDone.result.details?.passed).toBe(true);
  expect(await heldLocks(agentDirectory)).toEqual([]);
});

it('queues full checks of one repository from two checkouts and reports the wait', async () => {
  const { agentDirectory, record, gated, release } = await fixture();
  const first = await repositoryNamed('first');
  const second = await repositoryNamed('first', 'https://github.com/Owner/First.git');

  await configure(first, [process.execPath, gated, record, 'first', release]);
  await configure(second, [process.execPath, gated, record, 'first', release]);

  const firstRun = runTool(agentDirectory, first);
  await waitForLine(record, 'start first');

  const updates: string[] = [];
  const secondRun = runTool(agentDirectory, second, undefined, updates);

  await vi.waitFor(
    () => {
      expect(updates).toHaveLength(1);
    },
    { timeout: 4000 },
  );

  expect(await readLines(record)).toEqual(['start first']);

  await writeFile(release, '');

  const [firstDone, secondDone] = await Promise.all([firstRun, secondRun]);

  expect(await readLines(record)).toEqual(['start first', 'end first', 'start first', 'end first']);
  expect(firstDone.updates).toEqual([]);
  expect(updates[0]).toContain('Waiting');
  expect(updates[0]).toContain(first);
  expect(secondDone.result.details?.passed).toBe(true);
  expect(await heldLocks(agentDirectory)).toEqual([]);
});

it('keys the lock by repository without case or path separators', () => {
  const lower = defaultLockPath('/agent', 'owner/name');

  expect(defaultLockPath('/agent', 'Owner/Name')).toBe(lower);
  expect(dirname(lower)).toBe(join('/agent', 'tau', 'full-check'));
  expect(defaultLockPath('/agent', 'owner/other')).not.toBe(lower);
});

it('takes over a lock left by a dead process', async () => {
  const { agentDirectory, record, script } = await fixture();
  const root = await repositoryNamed('first');

  await configure(root, [process.execPath, script, record, 'first']);

  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = child.pid ?? 0;

  await new Promise((resolve) => {
    child.once('close', resolve);
  });

  await mkdir(dirname(lockPathFor(agentDirectory)), { recursive: true });

  await writeFile(
    `${lockPathFor(agentDirectory)}.1`,
    JSON.stringify({
      pid: deadPid,
      checkout: '/gone',
      startedAt: new Date().toISOString(),
      token: 'dead',
    }),
  );

  const { result, updates } = await runTool(agentDirectory, root);

  expect(result.details?.passed).toBe(true);
  expect(updates).toEqual([]);
  expect((await readFile(record, 'utf8')).trim().split('\n')).toEqual(['start first', 'end first']);
});

it('refuses a checkout whose repository file sets no command and runs no command', async () => {
  const { agentDirectory, record } = await fixture();
  const root = await repositoryNamed('first');

  await writeRepositoryFile(root, {});

  await expect(runTool(agentDirectory, root)).rejects.toThrow('Run your check as before');
  await expect(access(record)).rejects.toThrow('ENOENT');
  expect(await heldLocks(agentDirectory)).toEqual([]);
});

it('reports a failing check as a result with its log', async () => {
  const { agentDirectory } = await fixture();
  const root = await repositoryNamed('first');

  await configure(root, [process.execPath, '-e', 'console.log("boom"); process.exit(3)']);

  const { result } = await runTool(agentDirectory, root);

  expect(result.details).toMatchObject({ passed: false, exitCode: 3 });
  const logPath = result.details?.logPath ?? '';

  expect(logPath.startsWith(join(root, '.tau', 'checks'))).toBe(true);
  expect(await readFile(logPath, 'utf8')).toBe('boom\n');
  expect(result.details?.tail).toBe('boom');
});

const stubbornSource = `
const { appendFileSync } = require('node:fs');
const [record] = process.argv.slice(2);
process.on('SIGTERM', () => {
  setTimeout(() => {
    appendFileSync(record, 'end stubborn\\n');
    process.exit(0);
  }, 400);
});
appendFileSync(record, 'start stubborn\\n');
setInterval(() => {}, 1000);
`;

it('starts the next check only after a cancelled command has exited', async () => {
  const { agentDirectory, record, script } = await fixture();
  const stubborn = join(agentDirectory, '..', 'stubborn.cjs');
  const first = await repositoryNamed('first');
  const second = await repositoryNamed('second', 'git@github.com:owner/first.git');

  await writeFile(stubborn, stubbornSource);

  await configure(first, [process.execPath, stubborn, record]);

  const controller = new AbortController();

  const cancelled = runTool(agentDirectory, first, controller.signal).then(
    () => undefined,
    (error: unknown) => error,
  );

  await vi.waitFor(async () => {
    expect(await readFile(record, 'utf8')).toContain('start stubborn');
  });

  await configure(second, [process.execPath, script, record, 'second']);

  const queued = runTool(agentDirectory, second);

  // Lets the queued check start waiting for the lock.
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });

  controller.abort();

  expect(await cancelled).toBeInstanceOf(Error);
  expect((await queued).result.details?.passed).toBe(true);

  expect((await readFile(record, 'utf8')).trim().split('\n')).toEqual([
    'start stubborn',
    'end stubborn',
    'start second',
    'end second',
  ]);
});

it('lets only one of two sessions that recover the same stale lock run at a time', async () => {
  const { agentDirectory, record, script } = await fixture();
  const first = await repositoryNamed('first');
  const second = await repositoryNamed('second', 'git@github.com:owner/first.git');

  await configure(first, [process.execPath, script, record, 'first']);
  await configure(second, [process.execPath, script, record, 'first']);

  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = child.pid ?? 0;

  await new Promise((resolve) => {
    child.once('close', resolve);
  });

  await mkdir(dirname(lockPathFor(agentDirectory)), { recursive: true });

  await writeFile(
    `${lockPathFor(agentDirectory)}.1`,
    JSON.stringify({
      pid: deadPid,
      checkout: '/gone',
      startedAt: new Date().toISOString(),
      token: 'dead',
    }),
  );

  await Promise.all([runTool(agentDirectory, first), runTool(agentDirectory, second)]);

  const lines = (await readFile(record, 'utf8')).trim().split('\n');

  expect(lines).toEqual(['start first', 'end first', 'start first', 'end first']);
  expect(await heldLocks(agentDirectory)).toEqual([]);
});

const descendantSource = `
const { appendFileSync } = require('node:fs');
const [record] = process.argv.slice(2);
process.on('SIGTERM', () => {
  setTimeout(() => {
    appendFileSync(record, 'end descendant\\n');
    process.exit(0);
  }, 500);
});
appendFileSync(record, 'start descendant\\n');
setInterval(() => {}, 1000);
`;

const launcherSource = `
const { spawn } = require('node:child_process');
const [descendant, record] = process.argv.slice(2);
spawn(process.execPath, [descendant, record], { stdio: 'ignore' });
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

it('starts the next check only after a descendant of a cancelled command is gone', async () => {
  const { agentDirectory, record, script } = await fixture();
  const descendant = join(agentDirectory, '..', 'descendant.cjs');
  const launcher = join(agentDirectory, '..', 'launcher.cjs');
  const first = await repositoryNamed('first');
  const second = await repositoryNamed('second', 'git@github.com:owner/first.git');

  await writeFile(descendant, descendantSource);
  await writeFile(launcher, launcherSource);

  await configure(first, [process.execPath, launcher, descendant, record]);

  const controller = new AbortController();

  const cancelled = runTool(agentDirectory, first, controller.signal).then(
    () => undefined,
    (error: unknown) => error,
  );

  await vi.waitFor(async () => {
    expect(await readFile(record, 'utf8').catch(() => '')).toContain('start descendant');
  });

  await configure(second, [process.execPath, script, record, 'second']);

  const queued = runTool(agentDirectory, second);

  // Lets the queued check start waiting for the lock.
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });

  controller.abort();

  expect(await cancelled).toBeInstanceOf(Error);
  await queued;

  expect((await readFile(record, 'utf8')).trim().split('\n')).toEqual([
    'start descendant',
    'end descendant',
    'start second',
    'end second',
  ]);
});

it('waits for the command group of a dead session before running a new check', async () => {
  const { agentDirectory, record, script } = await fixture();
  const root = await repositoryNamed('first');

  await configure(root, [process.execPath, script, record, 'first']);

  const session = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = session.pid ?? 0;

  await new Promise((resolve) => {
    session.once('close', resolve);
  });

  const command = spawn(
    process.execPath,
    [
      '-e',
      "setTimeout(() => require('node:fs').appendFileSync(process.argv[1], 'end holder\\n'), 500)",
      record,
    ],
    { stdio: 'ignore', detached: true },
  );

  await mkdir(dirname(lockPathFor(agentDirectory)), { recursive: true });

  await writeFile(
    `${lockPathFor(agentDirectory)}.1`,
    JSON.stringify({
      pid: deadPid,
      checkout: '/gone',
      startedAt: new Date().toISOString(),
      token: 'dead',
      commandGroup: command.pid,
    }),
  );

  await runTool(agentDirectory, root);

  expect((await readFile(record, 'utf8')).trim().split('\n')).toEqual([
    'end holder',
    'start first',
    'end first',
  ]);
});
