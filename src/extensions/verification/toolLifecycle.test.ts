import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { ensureTauDirectory } from '../../tauDirectory.js';
import { readRunRecord, runDirectoryPath, runRecordPath } from '../../verification/verification.js';
import { createToolRepository, replaceStopCommand } from './fixtures/toolRepository.js';
import type { LaunchResult } from './launchAction.js';
import type { StopResult } from './stopAction.js';

it('a cancelled stop writes nothing and a later stop succeeds', async () => {
  const { run } = await createToolRepository(onTestFinished);

  const launched = await run({ action: 'launch', target: 'app' });
  const launch = launched.details as LaunchResult;

  if (launch.status !== 'ready') {
    throw new Error('The launch did not become ready.');
  }

  const controller = new AbortController();

  controller.abort();

  await expect(
    run({ action: 'stop', run: launch.run }, undefined, controller.signal),
  ).rejects.toThrow('The stop was cancelled. Call stop again to stop the run.');

  const cancelled = await readRunRecord(runRecordPath(launch.directory));

  expect(cancelled.status).toBe('valid');

  if (cancelled.status !== 'valid') {
    return;
  }

  expect(cancelled.record.stop).toBeNull();
  expect(cancelled.record.treeAtStop).toBeNull();

  const stopped = await run({ action: 'stop', run: launch.run });
  const stop = stopped.details as StopResult;

  expect(stop).toMatchObject({ run: launch.run, exitCode: 0 });
});

it('a stop cancelled after it starts retries with a fresh log', async () => {
  const { root, directory, marker, run } = await createToolRepository(onTestFinished);

  const launched = await run({ action: 'launch', target: 'app' });
  const launch = launched.details as LaunchResult;

  if (launch.status !== 'ready') {
    throw new Error('The launch did not become ready.');
  }

  const go = join(directory, 'go');
  const configPath = join(root, '.pi', 'tau.json');

  await replaceStopCommand(configPath, [
    'sh',
    '-c',
    `touch ${JSON.stringify(marker)}; while [ ! -f ${JSON.stringify(go)} ]; do sleep 0.05; done; exit 0`,
  ]);

  const controller = new AbortController();
  const cancelled = run({ action: 'stop', run: launch.run }, undefined, controller.signal);

  while (!existsSync(marker)) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  controller.abort();

  await expect(cancelled).rejects.toThrow(
    'The stop was cancelled. Call stop again to stop the run.',
  );

  const stopLog = join(launch.directory, 'stop.log');

  expect(existsSync(stopLog)).toBe(true);

  await writeFile(go, '');

  const stopped = await run({ action: 'stop', run: launch.run });
  const stop = stopped.details as StopResult;

  expect(stop).toMatchObject({ run: launch.run, exitCode: 0 });
  expect(stop.logPath.endsWith('stop-2.log')).toBe(true);

  const read = await readRunRecord(runRecordPath(launch.directory));

  expect(read.status).toBe('valid');

  if (read.status !== 'valid') {
    return;
  }

  expect(read.record.stop?.logPath).toBe('stop-2.log');
  expect(existsSync(stopLog)).toBe(true);
  expect(existsSync(join(launch.directory, 'stop-2.log'))).toBe(true);
});

it('stops a run after a malformed second target is added', async () => {
  const { root, run } = await createToolRepository(onTestFinished);

  const launched = await run({ action: 'launch', target: 'app' });
  const launch = launched.details as LaunchResult;

  if (launch.status !== 'ready') {
    throw new Error('The launch did not become ready.');
  }

  const configPath = join(root, '.pi', 'tau.json');

  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    verification: { targets: Record<string, unknown> };
  };

  config.verification.targets['broken'] = { launch: ['pnpm'] };
  await writeFile(configPath, JSON.stringify(config));

  const stopped = await run({ action: 'stop', run: launch.run });
  const stop = stopped.details as StopResult;

  expect(stop).toMatchObject({ run: launch.run, exitCode: 0 });
});

it('refuses a command that cannot start and a later stop succeeds', async () => {
  const { root, run } = await createToolRepository(onTestFinished);

  const launched = await run({ action: 'launch', target: 'app' });
  const launch = launched.details as LaunchResult;

  if (launch.status !== 'ready') {
    throw new Error('The launch did not become ready.');
  }

  const configPath = join(root, '.pi', 'tau.json');

  await replaceStopCommand(configPath, ['tau-command-that-does-not-exist']);

  await expect(run({ action: 'stop', run: launch.run })).rejects.toThrow(
    new RegExp(
      `^The stop for run ${launch.run} could not start: .*tau-command-that-does-not-exist.*See ${join(launch.directory, 'stop.log')}.*Call stop again after fixing the command\\.$`,
      'u',
    ),
  );

  const failed = await readRunRecord(runRecordPath(launch.directory));

  expect(failed.status).toBe('valid');

  if (failed.status !== 'valid') {
    return;
  }

  expect(failed.record.stop).toBeNull();
  expect(failed.record.treeAtStop).toBeNull();
  expect(existsSync(join(launch.directory, 'stop.log'))).toBe(true);

  await replaceStopCommand(configPath, ['sh', '-c', 'exit 0']);

  const stopped = await run({ action: 'stop', run: launch.run });
  const stop = stopped.details as StopResult;

  expect(stop).toMatchObject({ run: launch.run, exitCode: 0 });
});

it('refuses to stop a run with no record when .tau has no ignore rule', async () => {
  const { root, run } = await createToolRepository(onTestFinished);
  const runName = 'orphan';
  const directory = runDirectoryPath(root, runName);

  await mkdir(directory, { recursive: true });

  await expect(run({ action: 'stop', run: runName })).rejects.toThrow(
    `The run ${runName} has no run record at ${join(directory, 'run.json')}.`,
  );
});

it('refuses to stop a run whose directory has no run record', async () => {
  const { root, run } = await createToolRepository(onTestFinished);
  const runName = 'orphan';
  const directory = await ensureTauDirectory(root, `verification/${runName}`);

  await expect(run({ action: 'stop', run: runName })).rejects.toThrow(
    `The run ${runName} has no run record at ${join(directory, 'run.json')}.`,
  );
});

it('refuses a second stop', async () => {
  const { run } = await createToolRepository(onTestFinished);

  const launched = await run({ action: 'launch', target: 'app' });
  const launch = launched.details as LaunchResult;

  if (launch.status !== 'ready') {
    throw new Error('The launch did not become ready.');
  }

  await run({ action: 'stop', run: launch.run });

  await expect(run({ action: 'stop', run: launch.run })).rejects.toThrow(
    'The run is already stopped.',
  );
});

it('refuses to stop a run whose record names another run', async () => {
  const { run, marker } = await createToolRepository(onTestFinished);
  const first = (await run({ action: 'launch', target: 'app' })).details as LaunchResult;
  const second = (await run({ action: 'launch', target: 'app' })).details as LaunchResult;
  const otherRecord = await readFile(runRecordPath(second.directory), 'utf8');

  await writeFile(runRecordPath(first.directory), otherRecord);

  await expect(run({ action: 'stop', run: first.run })).rejects.toThrow(second.run);
  expect(existsSync(marker)).toBe(false);
  expect(await readFile(runRecordPath(first.directory), 'utf8')).toBe(otherRecord);
  expect(await readdir(first.directory)).not.toContain('stop.log');
});

const stopSymlinkTargets = [
  { name: '.tau', target: '.tau' },
  { name: '.tau/verification', target: '.tau/verification' },
];

it.each(stopSymlinkTargets)('refuses to stop when $name is a symlink', async ({ target }) => {
  const { root, marker, run } = await createToolRepository(onTestFinished);
  const launch = (await run({ action: 'launch', target: 'app' })).details as LaunchResult;
  const outside = temporaryDirectory(onTestFinished, 'tau-stop-outside-');
  const moved = join(outside, target);
  const movedRun = join(outside, relative(root, launch.directory));

  await mkdir(dirname(moved), { recursive: true });
  await rename(join(root, target), moved);
  await symlink(moved, join(root, target));

  const before = {
    entries: await readdir(outside, { recursive: true }),
    record: await readFile(runRecordPath(movedRun), 'utf8'),
  };

  const failure = await run({ action: 'stop', run: launch.run }).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect({
    failure,
    entries: await readdir(outside, { recursive: true }),
    record: await readFile(runRecordPath(movedRun), 'utf8'),
    stopped: existsSync(marker),
  }).toEqual({
    failure: `Refusing to write through a symlink: ${target}`,
    ...before,
    stopped: false,
  });
});

it('refuses to stop when the run record is not a regular file', async () => {
  const { marker, run } = await createToolRepository(onTestFinished);
  const launch = (await run({ action: 'launch', target: 'app' })).details as LaunchResult;
  const recordPath = runRecordPath(launch.directory);

  await rm(recordPath);
  await promisify(execFile)('mkfifo', [recordPath]);

  const failure = await run({ action: 'stop', run: launch.run }).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect({
    failure,
    recordIsFifo: (await lstat(recordPath)).isFIFO(),
    stopped: existsSync(marker),
  }).toEqual({
    failure: `Refusing to read a run record that is not a regular file: ${recordPath}`,
    recordIsFifo: true,
    stopped: false,
  });
});

it('keeps a run open when its stop command exits nonzero', async () => {
  const { root, run } = await createToolRepository(onTestFinished);
  const launch = (await run({ action: 'launch', target: 'app' })).details as LaunchResult;

  if (launch.status !== 'ready') {
    throw new Error('The launch did not become ready.');
  }

  const configPath = join(root, '.pi', 'tau.json');

  await replaceStopCommand(configPath, ['sh', '-c', 'exit 7']);

  const stopped = await run({ action: 'stop', run: launch.run });
  const stop = stopped.details as StopResult;

  expect(stop).toMatchObject({
    stopped: false,
    run: launch.run,
    exitCode: 7,
    freshness: { fresh: false, reason: 'notStopped' },
  });

  expect(stop.logPath.endsWith('stop.log')).toBe(true);
  expect(existsSync(stop.logPath)).toBe(true);

  const failed = await readRunRecord(runRecordPath(launch.directory));

  expect(failed.status).toBe('valid');

  if (failed.status !== 'valid') {
    return;
  }

  expect(failed.record.stop).toBeNull();
  expect(failed.record.treeAtStop).toBeNull();

  await replaceStopCommand(configPath, ['sh', '-c', 'exit 0']);

  const retried = await run({ action: 'stop', run: launch.run });
  const retry = retried.details as StopResult;

  expect(retry).toMatchObject({ stopped: true, run: launch.run, exitCode: 0 });
  expect(retry.logPath.endsWith('stop-2.log')).toBe(true);

  const stoppedRecord = await readRunRecord(runRecordPath(launch.directory));

  expect(stoppedRecord.status).toBe('valid');

  if (stoppedRecord.status !== 'valid') {
    return;
  }

  expect(stoppedRecord.record.stop?.exitCode).toBe(0);
  expect(stoppedRecord.record.stop?.logPath).toBe('stop-2.log');
});

it('keeps a run open when its stop command reaches the deadline', async () => {
  const { root, run } = await createToolRepository(onTestFinished);
  const launch = (await run({ action: 'launch', target: 'app' })).details as LaunchResult;

  if (launch.status !== 'ready') {
    throw new Error('The launch did not become ready.');
  }

  await replaceStopCommand(join(root, '.pi', 'tau.json'), ['sh', '-c', 'sleep 5']);

  const stopped = await run({ action: 'stop', run: launch.run }, 200);
  const stop = stopped.details as StopResult;

  expect(stop).toMatchObject({
    stopped: false,
    run: launch.run,
    exitCode: null,
    freshness: { fresh: false, reason: 'notStopped' },
  });

  expect(stop.logPath.endsWith('stop.log')).toBe(true);
  expect(existsSync(stop.logPath)).toBe(true);

  const failed = await readRunRecord(runRecordPath(launch.directory));

  expect(failed.status).toBe('valid');

  if (failed.status !== 'valid') {
    return;
  }

  expect(failed.record.stop).toBeNull();
  expect(failed.record.treeAtStop).toBeNull();
});
