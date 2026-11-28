import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { readRunRecord, runRecordPath } from '../../verification/verification.js';
import { createToolRepository, replaceStopCommand } from './fixtures/toolRepository.js';
import type { LaunchResult } from './launchAction.js';
import type { RegisterResult } from './registerAction.js';
import type { StopResult } from './stopAction.js';

it('launch, register, and stop save a valid run record', async () => {
  const { run } = await createToolRepository(onTestFinished);

  const launched = await run({ action: 'launch', target: 'app' });
  const launch = launched.details as LaunchResult;

  expect(launch.status).toBe('ready');

  if (launch.status !== 'ready') {
    return;
  }

  const registered = await run({
    action: 'register',
    run: launch.run,
    items: [{ item: 'login', steps: 1 }],
  });

  const register = registered.details as RegisterResult;

  expect(register).toMatchObject({ run: launch.run, items: [{ item: 'login', steps: 1 }] });

  const stopped = await run({ action: 'stop', run: launch.run });
  const stop = stopped.details as StopResult;

  expect(stop).toMatchObject({ run: launch.run, exitCode: 0, freshness: { fresh: true } });

  const read = await readRunRecord(runRecordPath(launch.directory));

  expect(read.status).toBe('valid');

  if (read.status !== 'valid') {
    return;
  }

  expect(read.record.treeAtLaunch).not.toBeNull();
  expect(read.record.treeAtStop).not.toBeNull();
  expect(read.record.platform).toEqual({ os: process.platform, arch: process.arch });
  expect(read.record.launch?.exitCode).toBe(0);
  expect(read.record.doctor?.exitCode).toBe(0);
  expect(read.record.stop?.exitCode).toBe(0);
  expect(read.record.items).toEqual([{ item: 'login', steps: 1 }]);
  expect((await stat(launch.directory)).isDirectory()).toBe(true);
});

it('a failed doctor returns failed with its log, and register refuses before and after stop', async () => {
  const { run } = await createToolRepository(onTestFinished, { doctorExitCode: 1 });

  const launched = await run({ action: 'launch', target: 'app' });
  const launch = launched.details as LaunchResult;

  expect(launch).toMatchObject({
    status: 'failed',
    command: 'doctor',
    exitCode: 1,
    stopped: false,
  });

  if (launch.status !== 'failed') {
    return;
  }

  expect(launch.logPath.endsWith('doctor.log')).toBe(true);
  expect(existsSync(launch.logPath)).toBe(true);

  await expect(
    run({ action: 'register', run: launch.run, items: [{ item: 'login', steps: 1 }] }),
  ).rejects.toThrow(/doctor/u);

  await run({ action: 'stop', run: launch.run });

  await expect(
    run({ action: 'register', run: launch.run, items: [{ item: 'login', steps: 1 }] }),
  ).rejects.toThrow(/stopped/u);

  const read = await readRunRecord(runRecordPath(launch.directory));

  expect(read.status).toBe('valid');

  if (read.status !== 'valid') {
    return;
  }

  expect(read.record.items).toEqual([]);
});

it('a launch past its deadline is stopped, stop runs, and launch returns failed', async () => {
  const { run, marker } = await createToolRepository(onTestFinished, { launchScript: 'sleep 5' });

  const launched = await run({ action: 'launch', target: 'app' }, 200);
  const launch = launched.details as LaunchResult;

  expect(launch).toMatchObject({
    status: 'failed',
    command: 'launch',
    exitCode: null,
    stopped: true,
  });

  if (launch.status !== 'failed') {
    return;
  }

  expect(existsSync(marker)).toBe(true);
  expect(launch.logPath.endsWith('launch.log')).toBe(true);

  const read = await readRunRecord(runRecordPath(launch.directory));

  expect(read.status).toBe('valid');

  if (read.status !== 'valid') {
    return;
  }

  expect(read.record.launch?.exitCode).toBeNull();
  expect(read.record.stop?.exitCode).toBe(0);
});

it('a timed-out launch whose stop fails returns stopped false and a later stop succeeds', async () => {
  const { root, run } = await createToolRepository(onTestFinished, { launchScript: 'sleep 5' });
  const configPath = join(root, '.pi', 'tau.json');

  await replaceStopCommand(configPath, ['sh', '-c', 'exit 7']);

  const launched = await run({ action: 'launch', target: 'app' }, 200);
  const launch = launched.details as LaunchResult;

  expect(launch).toMatchObject({ status: 'failed', command: 'launch', stopped: false });

  if (launch.status !== 'failed') {
    return;
  }

  const failed = await readRunRecord(runRecordPath(launch.directory));

  expect(failed.status).toBe('valid');

  if (failed.status !== 'valid') {
    return;
  }

  expect(failed.record.stop).toBeNull();

  await replaceStopCommand(configPath, ['sh', '-c', 'exit 0']);

  const stopped = await run({ action: 'stop', run: launch.run });
  const stop = stopped.details as StopResult;

  expect(stop).toMatchObject({ stopped: true, exitCode: 0 });

  const stoppedRecord = await readRunRecord(runRecordPath(launch.directory));

  expect(stoppedRecord.status).toBe('valid');

  if (stoppedRecord.status !== 'valid') {
    return;
  }

  expect(stoppedRecord.record.stop?.exitCode).toBe(0);
});

it('a non-zero launch returns failed for launch and skips doctor', async () => {
  const { run, seen } = await createToolRepository(onTestFinished, { launchScript: 'exit 3' });

  const launched = await run({ action: 'launch', target: 'app' });
  const launch = launched.details as LaunchResult;

  expect(launch).toMatchObject({
    status: 'failed',
    command: 'launch',
    exitCode: 3,
    stopped: false,
  });

  if (launch.status !== 'failed') {
    return;
  }

  expect(launch.logPath.endsWith('launch.log')).toBe(true);
  expect(await readFile(seen, 'utf8')).toBe('');

  const read = await readRunRecord(runRecordPath(launch.directory));

  expect(read.status).toBe('valid');

  if (read.status !== 'valid') {
    return;
  }

  expect(read.record.doctor).toBeNull();
});

it('records the head and dirty state of the tree', async () => {
  const { root, run } = await createToolRepository(onTestFinished);
  const head = await git(root, 'rev-parse', 'HEAD');

  const clean = await run({ action: 'launch', target: 'app' });
  const cleanLaunch = clean.details as LaunchResult;

  if (cleanLaunch.status !== 'ready') {
    throw new Error('The launch did not become ready.');
  }

  const cleanRead = await readRunRecord(runRecordPath(cleanLaunch.directory));

  expect(cleanRead.status).toBe('valid');

  if (cleanRead.status !== 'valid') {
    return;
  }

  expect(cleanRead.record.head).toBe(head);
  expect(cleanRead.record.dirty).toBe(false);

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const dirty = await run({ action: 'launch', target: 'app' });
  const dirtyLaunch = dirty.details as LaunchResult;

  if (dirtyLaunch.status !== 'ready') {
    throw new Error('The launch did not become ready.');
  }

  const dirtyRead = await readRunRecord(runRecordPath(dirtyLaunch.directory));

  expect(dirtyRead.status).toBe('valid');

  if (dirtyRead.status !== 'valid') {
    return;
  }

  expect(dirtyRead.record.head).toBe(head);
  expect(dirtyRead.record.dirty).toBe(true);
});

it('launch, doctor, and stop receive the run and its directory', async () => {
  const { run, seen } = await createToolRepository(onTestFinished);

  const launched = await run({ action: 'launch', target: 'app' });
  const launch = launched.details as LaunchResult;

  if (launch.status !== 'ready') {
    throw new Error('The launch did not become ready.');
  }

  await run({ action: 'stop', run: launch.run });

  const lines = (await readFile(seen, 'utf8')).trim().split('\n');

  expect(lines).toHaveLength(3);

  for (const line of lines) {
    const [runName, directory] = line.split('|');

    expect(runName).toBe(launch.run);
    expect(directory).toBe(launch.directory);
    expect(isAbsolute(directory ?? '')).toBe(true);
  }
});

it('refuses an unknown target', async () => {
  const { run } = await createToolRepository(onTestFinished);

  await expect(run({ action: 'launch', target: 'missing' })).rejects.toThrow(/app/u);
});

it.each([
  {
    input: { action: 'launch' as const, target: 'app', run: 'other' },
    message: 'launch does not take run.',
  },
  {
    input: { action: 'launch' as const, target: 'app', items: [{ item: 'login', steps: 1 }] },
    message: 'launch does not take items.',
  },
  { input: { action: 'launch' as const }, message: 'launch needs target.' },
  {
    input: { action: 'register' as const, target: 'app', run: 'other', items: [] },
    message: 'register does not take target.',
  },
  {
    input: { action: 'register' as const, items: [{ item: 'login', steps: 1 }] },
    message: 'register needs run.',
  },
  { input: { action: 'register' as const, run: 'other' }, message: 'register needs items.' },
  {
    input: { action: 'stop' as const, target: 'app', run: 'other' },
    message: 'stop does not take target.',
  },
  {
    input: { action: 'stop' as const, run: 'other', items: [{ item: 'login', steps: 1 }] },
    message: 'stop does not take items.',
  },
  { input: { action: 'stop' as const }, message: 'stop needs run.' },
])('refuses $message', async ({ input, message }) => {
  const { run } = await createToolRepository(onTestFinished);

  await expect(run(input)).rejects.toThrow(message);
});

const registerSymlinkTargets = [
  { name: '.tau', target: '.tau' },
  { name: '.tau/verification', target: '.tau/verification' },
];

it.each(registerSymlinkTargets)(
  'refuses to register when $name is a symlink',
  async ({ target }) => {
    const { root, run } = await createToolRepository(onTestFinished);
    const launch = (await run({ action: 'launch', target: 'app' })).details as LaunchResult;
    const outside = temporaryDirectory(onTestFinished, 'tau-register-outside-');
    const moved = join(outside, target);

    const movedRun = join(outside, relative(root, launch.directory));

    await mkdir(dirname(moved), { recursive: true });
    await rename(join(root, target), moved);
    await symlink(moved, join(root, target));

    const before = {
      entries: await readdir(outside, { recursive: true }),
      record: await readFile(runRecordPath(movedRun), 'utf8'),
    };

    const failure = await run({
      action: 'register',
      run: launch.run,
      items: [{ item: 'login', steps: 1 }],
    }).then(
      () => 'no error',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect({
      failure,
      entries: await readdir(outside, { recursive: true }),
      record: await readFile(runRecordPath(movedRun), 'utf8'),
    }).toEqual({
      failure: `Refusing to write through a symlink: ${target}`,
      ...before,
    });
  },
);

it('refuses to register when the run record is not a regular file', async () => {
  const { run } = await createToolRepository(onTestFinished);
  const launch = (await run({ action: 'launch', target: 'app' })).details as LaunchResult;
  const recordPath = runRecordPath(launch.directory);

  await rm(recordPath);
  await promisify(execFile)('mkfifo', [recordPath]);

  const failure = await run({
    action: 'register',
    run: launch.run,
    items: [{ item: 'login', steps: 1 }],
  }).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect({ failure, recordIsFifo: (await lstat(recordPath)).isFIFO() }).toEqual({
    failure: `Refusing to read a run record that is not a regular file: ${recordPath}`,
    recordIsFifo: true,
  });
});
