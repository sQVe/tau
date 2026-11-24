import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { processState } from '../src/process/process.ts';

export type OsLockState = 'free' | 'held';

export type SpikeObservation =
  | { readonly case: 'secondHolder'; readonly secondExitCode: number | null }
  | {
      readonly case: 'holderOutlivesParent';
      readonly holderAlive: boolean;
      readonly state: OsLockState;
    }
  | { readonly case: 'everyHolderGone'; readonly before: OsLockState; readonly after: OsLockState }
  | {
      readonly case: 'detachedChild';
      readonly parentExitCode: number | null;
      readonly state: OsLockState;
    }
  | {
      readonly case: 'wrapperAcrossExec';
      readonly secondExitCode: number | null;
      readonly stateAfterKillingHolder: OsLockState;
    }
  | {
      readonly case: 'supervisorWithoutFork';
      readonly stateAfterSupervisorKilled: OsLockState;
      readonly stateAfterGroupKilled: OsLockState;
    };

interface ParentHolder {
  parent: ChildProcess;
  holderPid: number;
}

// flock reports a taken lock with -E, and reports its own failures with <sysexits.h> codes. Once
// the command runs, its exit code replaces flock's.
export const osLockConflictExitCode = 75;

const probePollMilliseconds = 20;
const probeTimeoutMilliseconds = 10_000;
const holderSeconds = '60';

// -F replaces flock with the command, so the command's own process holds the lock and no wrapper
// process has to stay alive for it.
export const osLockWrapperArgv = (lockPath: string, commandArgv: readonly string[]): string[] => [
  'flock',
  '-F',
  '-n',
  '-E',
  String(osLockConflictExitCode),
  lockPath,
  ...commandArgv,
];

const startCommand = (argv: readonly string[], detached = false): ChildProcess => {
  const [command, ...commandArguments] = argv;

  if (command === undefined) {
    throw new Error('A spike command needs a program to run.');
  }

  return spawn(command, commandArguments, { detached, stdio: 'ignore' });
};

const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const waitForExit = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve, reject) => {
    if (hasExited(child)) {
      resolve(child.exitCode);

      return;
    }

    child.once('error', reject);

    child.once('exit', (code) => {
      resolve(code);
    });
  });

const stopCommand = async (child: ChildProcess): Promise<void> => {
  if (!hasExited(child)) {
    child.kill('SIGKILL');
  }

  await waitForExit(child).catch(() => undefined);
};

const runCommand = (argv: readonly string[]): Promise<number | null> =>
  waitForExit(startCommand(argv));

const startHolder = (lockPath: string): ChildProcess =>
  startCommand(osLockWrapperArgv(lockPath, ['sleep', holderSeconds]));

// A probe takes the lock and lets go of it at once. It is therefore not read-only: a launch that
// races the probe sees the conflict code.
export const readOsLockState = async (lockPath: string): Promise<OsLockState> => {
  const exitCode = await runCommand(osLockWrapperArgv(lockPath, ['true']));

  if (exitCode === osLockConflictExitCode) {
    return 'held';
  }

  if (exitCode === 0) {
    return 'free';
  }

  throw new Error(`The lock probe on ${lockPath} exited ${String(exitCode)}.`);
};

export const waitForOsLockState = async (
  lockPath: string,
  wanted: OsLockState,
): Promise<OsLockState> => {
  const deadline = Date.now() + probeTimeoutMilliseconds;
  let state = await readOsLockState(lockPath);

  while (state !== wanted && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- Each probe reads the state the last one left.
    await sleep(probePollMilliseconds);
    // oxlint-disable-next-line no-await-in-loop -- Each probe reads the state the last one left.
    state = await readOsLockState(lockPath);
  }

  return state;
};

export const secondHolderRefused = async (lockPath: string): Promise<number | null> => {
  const holder = startHolder(lockPath);

  try {
    await waitForOsLockState(lockPath, 'held');

    return await runCommand(osLockWrapperArgv(lockPath, ['true']));
  } finally {
    await stopCommand(holder);
  }
};

const parentFixturePath = new URL('fixtures/osLockParent.ts', import.meta.url).pathname;

const readProcessId = (child: ChildProcess): Promise<number> =>
  new Promise((resolve, reject) => {
    let text = '';

    child.once('error', reject);

    child.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');

      const newline = text.indexOf('\n');

      if (newline !== -1) {
        resolve(Number(text.slice(0, newline)));
      }
    });
  });

const startParentWithHolder = async (
  mode: 'exit' | 'wait',
  lockPath: string,
): Promise<ParentHolder> => {
  const parent = spawn(
    process.execPath,
    [parentFixturePath, mode, ...osLockWrapperArgv(lockPath, ['sleep', holderSeconds])],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );

  return { parent, holderPid: await readProcessId(parent) };
};

// A signal aimed at no process would reach the caller's own process group.
const stopProcess = (processId: number | undefined, signal: NodeJS.Signals): void => {
  if (processId === undefined) {
    return;
  }

  try {
    process.kill(processId, signal);
  } catch {
    // A process that is already gone needs no signal.
  }
};

const stopGroup = (groupId: number | undefined, signal: NodeJS.Signals): void => {
  const negatedGroupId = groupId === undefined ? undefined : -groupId;

  stopProcess(negatedGroupId, signal);
};

export const holderOutlivesKilledParent = async (
  lockPath: string,
): Promise<{ holderAlive: boolean; state: OsLockState }> => {
  const { parent, holderPid } = await startParentWithHolder('wait', lockPath);

  try {
    await waitForOsLockState(lockPath, 'held');

    stopProcess(parent.pid, 'SIGKILL');
    await waitForExit(parent).catch(() => undefined);

    return {
      holderAlive: processState(holderPid) !== 'gone',
      state: await readOsLockState(lockPath),
    };
  } finally {
    stopProcess(holderPid, 'SIGKILL');
    await waitForOsLockState(lockPath, 'free');
  }
};

export const lockFreesWhenEveryHolderIsGone = async (
  lockPath: string,
): Promise<{ before: OsLockState; after: OsLockState }> => {
  const holder = startHolder(lockPath);

  try {
    const before = await waitForOsLockState(lockPath, 'held');

    await stopCommand(holder);

    return { before, after: await waitForOsLockState(lockPath, 'free') };
  } finally {
    await stopCommand(holder);
  }
};

export const detachedChildKeepsLockAfterParentExit = async (
  lockPath: string,
): Promise<{ parentExitCode: number | null; state: OsLockState }> => {
  const { parent, holderPid } = await startParentWithHolder('exit', lockPath);

  try {
    const parentExitCode = await waitForExit(parent);

    return { parentExitCode, state: await readOsLockState(lockPath) };
  } finally {
    stopProcess(holderPid, 'SIGKILL');
    await waitForOsLockState(lockPath, 'free');
  }
};

export const wrapperHoldsLockAcrossExec = async (
  lockPath: string,
): Promise<{ secondExitCode: number | null; stateAfterKillingHolder: OsLockState }> => {
  const wrapper = startHolder(lockPath);

  try {
    await waitForOsLockState(lockPath, 'held');

    const secondExitCode = await runCommand(osLockWrapperArgv(lockPath, ['true']));

    // The spawned pid is the child itself because flock execs it, so killing that pid frees the
    // lock. A forked wrapper would leave the child holding it.
    await stopCommand(wrapper);

    return {
      secondExitCode,
      stateAfterKillingHolder: await waitForOsLockState(lockPath, 'free'),
    };
  } finally {
    await stopCommand(wrapper);
  }
};

// Without -F, flock forks and the command inherits the locked descriptor. The lock then outlives
// the supervisor, and only the command's own group ends it.
export const supervisorWithoutFork = async (
  lockPath: string,
): Promise<{ stateAfterSupervisorKilled: OsLockState; stateAfterGroupKilled: OsLockState }> => {
  const supervisor = startCommand(
    ['flock', '-n', '-E', String(osLockConflictExitCode), lockPath, 'sleep', holderSeconds],
    true,
  );

  try {
    await waitForOsLockState(lockPath, 'held');

    stopProcess(supervisor.pid, 'SIGKILL');
    await waitForExit(supervisor).catch(() => undefined);

    const stateAfterSupervisorKilled = await readOsLockState(lockPath);

    stopGroup(supervisor.pid, 'SIGKILL');

    return {
      stateAfterSupervisorKilled,
      stateAfterGroupKilled: await waitForOsLockState(lockPath, 'free'),
    };
  } finally {
    stopGroup(supervisor.pid, 'SIGKILL');
    await stopCommand(supervisor);
  }
};

export const runSpike = async (directory: string): Promise<SpikeObservation[]> => {
  const lockPathOf = (name: string): string => `${directory}/${name}`;

  const secondExitCode = await secondHolderRefused(lockPathOf('second-holder'));
  const outlivedParent = await holderOutlivesKilledParent(lockPathOf('killed-parent'));
  const everyHolderGone = await lockFreesWhenEveryHolderIsGone(lockPathOf('every-holder-gone'));
  const detachedChild = await detachedChildKeepsLockAfterParentExit(lockPathOf('detached-child'));
  const acrossExec = await wrapperHoldsLockAcrossExec(lockPathOf('wrapper-exec'));
  const supervisor = await supervisorWithoutFork(lockPathOf('supervisor'));

  return [
    { case: 'secondHolder', secondExitCode },
    { case: 'holderOutlivesParent', ...outlivedParent },
    { case: 'everyHolderGone', ...everyHolderGone },
    { case: 'detachedChild', ...detachedChild },
    { case: 'wrapperAcrossExec', ...acrossExec },
    { case: 'supervisorWithoutFork', ...supervisor },
  ];
};

export const formatObservation = (observation: SpikeObservation): string => {
  const facts = Object.entries(observation).filter(([name]) => name !== 'case');
  const rendered = facts.map(([name, value]) => `${name}=${String(value)}`);

  return `${observation.case}: ${rendered.join(' ')}`;
};

if (import.meta.main) {
  const directory = await mkdtemp(join(tmpdir(), 'tau-os-lock-spike-'));

  try {
    for (const observation of await runSpike(directory)) {
      process.stdout.write(`${formatObservation(observation)}\n`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
