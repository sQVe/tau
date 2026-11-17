import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { readRunRecord, runRecordPath } from '../../verification/verification.js';
import type { LaunchResult } from './launchAction.js';
import type { RegisterResult } from './registerAction.js';
import type { StopResult } from './stopAction.js';
import { createVerificationTool } from './tool.js';

interface FixtureOptions {
  doctorExitCode?: number;
  launchScript?: string;
}

interface ToolInput {
  action: 'launch' | 'register' | 'stop';
  target?: string;
  run?: string;
  items?: { item: string; steps: number }[];
}

const fixture = async (options: FixtureOptions = {}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-verification-tool-');
  const root = await createTemporaryRepository(onTestFinished, 'tau-verification-tool-repo-');
  const seen = join(directory, 'seen.txt');
  const marker = join(directory, 'stopped');

  await writeFile(seen, '');
  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await mkdir(join(root, '.pi'));

  const record = `printf '%s|%s\\n' "$TAU_VERIFICATION_RUN" "$TAU_VERIFICATION_DIRECTORY" >> ${JSON.stringify(seen)}`;
  const launch = options.launchScript ?? `${record}; exit 0`;
  const doctor = `${record}; exit ${options.doctorExitCode ?? 0}`;
  const stop = `${record}; touch ${JSON.stringify(marker)}; exit 0`;

  await writeFile(
    join(root, '.pi', 'tau.json'),
    JSON.stringify({
      verification: {
        targets: {
          app: {
            launch: ['sh', '-c', launch],
            doctor: ['sh', '-c', doctor],
            stop: ['sh', '-c', stop],
          },
        },
      },
    }),
  );

  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');

  const run = (input: ToolInput, deadlineMilliseconds?: number, signal?: AbortSignal) =>
    createVerificationTool({
      agentDirectory: directory,
      ...(deadlineMilliseconds === undefined ? {} : { deadlineMilliseconds }),
    }).execute('call', input, signal, undefined, {
      cwd: root,
      isProjectTrusted: () => true,
      ui: { notify: () => undefined },
    } as never);

  return { root, directory, seen, marker, run };
};

it('launch, register, and stop save a valid run record', async () => {
  const { run } = await fixture();

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
  const { run } = await fixture({ doctorExitCode: 1 });

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
  const { run, marker } = await fixture({ launchScript: 'sleep 5' });

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

  const read = await readRunRecord(runRecordPath(launch.directory));

  expect(read.status).toBe('valid');

  if (read.status !== 'valid') {
    return;
  }

  expect(read.record.launch?.exitCode).toBeNull();
  expect(read.record.stop?.exitCode).toBe(0);
});

it('a non-zero launch returns failed for launch and skips doctor', async () => {
  const { run, seen } = await fixture({ launchScript: 'exit 3' });

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
  const { root, run } = await fixture();
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
  const { run, seen } = await fixture();

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
  const { run } = await fixture();

  await expect(run({ action: 'launch', target: 'missing' })).rejects.toThrow(/app/u);
});

it('refuses a second stop', async () => {
  const { run } = await fixture();

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

it('a cancelled stop writes nothing and a later stop succeeds', async () => {
  const { run } = await fixture();

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
  const { root, directory, marker, run } = await fixture();

  const launched = await run({ action: 'launch', target: 'app' });
  const launch = launched.details as LaunchResult;

  if (launch.status !== 'ready') {
    throw new Error('The launch did not become ready.');
  }

  const go = join(directory, 'go');
  const configPath = join(root, '.pi', 'tau.json');

  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    verification: { targets: { app: { stop: string[] } } };
  };

  config.verification.targets.app.stop = [
    'sh',
    '-c',
    `touch ${JSON.stringify(marker)}; while [ ! -f ${JSON.stringify(go)} ]; do sleep 0.05; done; exit 0`,
  ];

  await writeFile(configPath, JSON.stringify(config));

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
  const { root, run } = await fixture();

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
  const { root, run } = await fixture();

  const launched = await run({ action: 'launch', target: 'app' });
  const launch = launched.details as LaunchResult;

  if (launch.status !== 'ready') {
    throw new Error('The launch did not become ready.');
  }

  const configPath = join(root, '.pi', 'tau.json');

  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    verification: { targets: { app: { stop: string[] } } };
  };

  config.verification.targets.app.stop = ['tau-command-that-does-not-exist'];
  await writeFile(configPath, JSON.stringify(config));

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

  config.verification.targets.app.stop = ['sh', '-c', 'exit 0'];
  await writeFile(configPath, JSON.stringify(config));

  const stopped = await run({ action: 'stop', run: launch.run });
  const stop = stopped.details as StopResult;

  expect(stop).toMatchObject({ run: launch.run, exitCode: 0 });
});

it('refuses to stop a run whose directory has no run record', async () => {
  const { root, run } = await fixture();
  const runName = 'orphan';
  const directory = join(root, '.tau', 'verification', runName);

  await mkdir(directory, { recursive: true });

  await expect(run({ action: 'stop', run: runName })).rejects.toThrow(
    `The run ${runName} has no run record at ${join(directory, 'run.json')}.`,
  );
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
  const { run } = await fixture();

  await expect(run(input)).rejects.toThrow(message);
});

it('refuses to stop a run whose record names another run', async () => {
  const { run, marker } = await fixture();
  const first = (await run({ action: 'launch', target: 'app' })).details as LaunchResult;
  const second = (await run({ action: 'launch', target: 'app' })).details as LaunchResult;
  const otherRecord = await readFile(runRecordPath(second.directory), 'utf8');

  await writeFile(runRecordPath(first.directory), otherRecord);

  await expect(run({ action: 'stop', run: first.run })).rejects.toThrow(second.run);
  expect(existsSync(marker)).toBe(false);
  expect(await readFile(runRecordPath(first.directory), 'utf8')).toBe(otherRecord);
  expect(await readdir(first.directory)).not.toContain('stop.log');
});
