import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { defaultLockPath, withFullCheckLock } from './queue.js';
import { createFullCheckTool } from './tool.js';

const recorderSource = `
const { appendFileSync } = require('node:fs');
const [record, name] = process.argv.slice(2);
appendFileSync(record, 'start ' + name + '\\n');
setTimeout(() => {
  appendFileSync(record, 'end ' + name + '\\n');
}, 300);
`;

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-full-check-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const agentDirectory = join(directory, 'agent');
  const record = join(directory, 'record.txt');
  const script = join(directory, 'recorder.cjs');

  await mkdir(agentDirectory);
  await writeFile(script, recorderSource);

  return { agentDirectory, record, script };
};

const repositoryNamed = async (name: string) => {
  const root = await createTemporaryRepository(onTestFinished, `tau-full-check-${name}-`);

  await promisify(execFile)(
    'git',
    ['remote', 'add', 'origin', `git@github.com:owner/${name}.git`],
    {
      cwd: root,
    },
  );

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

const configure = async (
  agentDirectory: string,
  repositories: Record<string, { argv: string[] }>,
) => {
  await writeFile(
    join(agentDirectory, 'tau.json'),
    JSON.stringify({ fullCheck: { repositories } }),
  );
};

// Lists the lock files whose owner has not released them.
const heldLocks = async (agentDirectory: string) => {
  const directory = join(agentDirectory, 'tau');

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

const runTool = async (agentDirectory: string, cwd: string, signal?: AbortSignal) => {
  const updates: string[] = [];

  const result = await createFullCheckTool({ agentDirectory, pollMilliseconds: 10 }).execute(
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

it('runs full checks from two repositories one after the other and reports the wait', async () => {
  const { agentDirectory, record, script } = await fixture();
  const first = await repositoryNamed('first');
  const second = await repositoryNamed('second');

  await configure(agentDirectory, {
    'owner/first': { argv: [process.execPath, script, record, 'first'] },
    'owner/second': { argv: [process.execPath, script, record, 'second'] },
  });

  const [firstRun, secondRun] = await Promise.all([
    runTool(agentDirectory, first),
    runTool(agentDirectory, second),
  ]);

  const lines = (await readFile(record, 'utf8')).trim().split('\n');
  const [starter = ''] = lines;
  const name = starter.replace('start ', '');
  const other = name === 'first' ? 'second' : 'first';

  expect(lines).toEqual([`start ${name}`, `end ${name}`, `start ${other}`, `end ${other}`]);

  const waiter = name === 'first' ? secondRun : firstRun;
  const runner = name === 'first' ? firstRun : secondRun;

  expect(runner.updates).toEqual([]);
  expect(waiter.updates).toHaveLength(1);
  expect(waiter.updates[0]).toContain('Waiting');
  expect(waiter.updates[0]).toContain(name === 'first' ? first : second);
  expect(waiter.result.details?.passed).toBe(true);
  expect(await heldLocks(agentDirectory)).toEqual([]);
});

it('takes over a lock left by a dead process', async () => {
  const { agentDirectory, record, script } = await fixture();
  const root = await repositoryNamed('first');

  await configure(agentDirectory, {
    'owner/first': { argv: [process.execPath, script, record, 'first'] },
  });

  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = child.pid ?? 0;

  await new Promise((resolve) => {
    child.once('close', resolve);
  });

  await mkdir(join(agentDirectory, 'tau'));

  await writeFile(
    `${defaultLockPath(agentDirectory)}.1`,
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

it('refuses a repository with no entry and runs no command', async () => {
  const { agentDirectory, record, script } = await fixture();
  const root = await repositoryNamed('first');

  await configure(agentDirectory, {
    'owner/other': { argv: [process.execPath, script, record, 'other'] },
  });

  await expect(runTool(agentDirectory, root)).rejects.toThrow('Run your check as before');
  await expect(access(record)).rejects.toThrow('ENOENT');
  expect(await heldLocks(agentDirectory)).toEqual([]);
});

it('reports a failing check as a result with its log', async () => {
  const { agentDirectory } = await fixture();
  const root = await repositoryNamed('first');

  await configure(agentDirectory, {
    'owner/first': { argv: [process.execPath, '-e', 'console.log("boom"); process.exit(3)'] },
  });

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
  const second = await repositoryNamed('second');

  await writeFile(stubborn, stubbornSource);

  await configure(agentDirectory, {
    'owner/first': { argv: [process.execPath, stubborn, record] },
    'owner/second': { argv: [process.execPath, script, record, 'second'] },
  });

  const controller = new AbortController();

  const cancelled = runTool(agentDirectory, first, controller.signal).then(
    () => undefined,
    (error: unknown) => error,
  );

  await vi.waitFor(async () => {
    expect(await readFile(record, 'utf8')).toContain('start stubborn');
  });

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
  const second = await repositoryNamed('second');

  await configure(agentDirectory, {
    'owner/first': { argv: [process.execPath, script, record, 'first'] },
    'owner/second': { argv: [process.execPath, script, record, 'second'] },
  });

  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = child.pid ?? 0;

  await new Promise((resolve) => {
    child.once('close', resolve);
  });

  await mkdir(join(agentDirectory, 'tau'));

  await writeFile(
    `${defaultLockPath(agentDirectory)}.1`,
    JSON.stringify({
      pid: deadPid,
      checkout: '/gone',
      startedAt: new Date().toISOString(),
      token: 'dead',
    }),
  );

  await Promise.all([runTool(agentDirectory, first), runTool(agentDirectory, second)]);

  const lines = (await readFile(record, 'utf8')).trim().split('\n');
  const [starter = ''] = lines;
  const name = starter.replace('start ', '');
  const other = name === 'first' ? 'second' : 'first';

  expect(lines).toEqual([`start ${name}`, `end ${name}`, `start ${other}`, `end ${other}`]);
  expect(await heldLocks(agentDirectory)).toEqual([]);
});

const ownerJson = (token: string, released = false) =>
  JSON.stringify({
    pid: process.pid,
    checkout: '/other',
    startedAt: new Date().toISOString(),
    token,
    ...(released ? { released: true } : {}),
  });

it('does not run while a higher generation is live after linking a lower one', async () => {
  const { agentDirectory } = await fixture();
  const lockPath = defaultLockPath(agentDirectory);
  const live = `${lockPath}.3`;

  await mkdir(join(agentDirectory, 'tau'));
  await writeFile(`${lockPath}.1`, ownerJson('first', true));

  let stalled = false;
  let ranWhileLive = false;

  await withFullCheckLock(
    {
      lockPath,
      checkout: '/stalled',
      signal: undefined,
      pollMilliseconds: 10,
      onWaiting: () => undefined,
      beforeLink: async () => {
        if (stalled) {
          return;
        }

        stalled = true;
        await writeFile(live, ownerJson('third'));
        await rm(`${lockPath}.1`);

        setTimeout(() => {
          writeFile(live, ownerJson('third', true)).catch(() => undefined);
        }, 150);
      },
    },
    async () => {
      const text = await readFile(live, 'utf8').catch(() => undefined);

      // A removed file means the higher holder released and was replaced.
      ranWhileLive = text !== undefined && !text.includes('"released":true');
    },
  );

  expect(ranWhileLive).toBe(false);
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
  const second = await repositoryNamed('second');

  await writeFile(descendant, descendantSource);
  await writeFile(launcher, launcherSource);

  await configure(agentDirectory, {
    'owner/first': { argv: [process.execPath, launcher, descendant, record] },
    'owner/second': { argv: [process.execPath, script, record, 'second'] },
  });

  const controller = new AbortController();

  const cancelled = runTool(agentDirectory, first, controller.signal).then(
    () => undefined,
    (error: unknown) => error,
  );

  await vi.waitFor(async () => {
    expect(await readFile(record, 'utf8').catch(() => '')).toContain('start descendant');
  });

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

  await configure(agentDirectory, {
    'owner/first': { argv: [process.execPath, script, record, 'first'] },
  });

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

  await mkdir(join(agentDirectory, 'tau'));

  await writeFile(
    `${defaultLockPath(agentDirectory)}.1`,
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
