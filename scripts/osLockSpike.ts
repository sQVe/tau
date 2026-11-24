import { spawn } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { processState, signalGroup, stopGroup } from '../src/process/process.ts';
import { readProcessId } from './osLockProcessId.ts';

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
      readonly stateBeforeParentExit: OsLockState;
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

interface StartOptions {
  detached?: boolean;
  stdio?: StdioOptions;
}

type CommandOutcome =
  | { readonly kind: 'exit'; readonly code: number | null }
  | { readonly kind: 'startFailed'; readonly error: Error };

// flock reports a taken lock with -E, and reports its own failures with <sysexits.h> codes. Once
// the command runs, its exit code replaces flock's.
export const osLockConflictExitCode = 75;
export const osLockMarkerWriteExitCode = 74;

export const osLockParentFixturePathFrom = (moduleUrl: URL): string =>
  fileURLToPath(new URL('../tests/osLockParentHarness.ts', moduleUrl));

export const osLockParentFixturePath = osLockParentFixturePathFrom(new URL(import.meta.url));

const probePollMilliseconds = 20;
const probeTimeoutMilliseconds = 10_000;
const holderSeconds = '60';
const holderReadyScript = `printf ready > "$1" || exit ${String(osLockMarkerWriteExitCode)}; shift; exec "$@"`;

const flockArgv = (lockPath: string, commandArgv: readonly string[], noFork: boolean): string[] => [
  'flock',
  ...(noFork ? ['-F'] : []),
  '-n',
  '-E',
  String(osLockConflictExitCode),
  lockPath,
  ...commandArgv,
];

export const osLockWrapperArgv = (lockPath: string, commandArgv: readonly string[]): string[] =>
  flockArgv(lockPath, commandArgv, true);

// The marker is written after flock has taken the lock, so a probe that runs once the marker
// exists cannot win the lock from the holder.
export const osLockHolderArgv = (markerPath: string, commandArgv: readonly string[]): string[] => [
  'sh',
  '-c',
  holderReadyScript,
  'tau-os-lock-holder',
  markerPath,
  ...commandArgv,
];

const sleepHolderArgv = (lockPath: string, markerPath: string, noFork: boolean): string[] =>
  flockArgv(lockPath, osLockHolderArgv(markerPath, ['sleep', holderSeconds]), noFork);

const commandOutcomes = new WeakMap<ChildProcess, Promise<CommandOutcome>>();

const startCommand = (argv: readonly string[], options: StartOptions = {}): ChildProcess => {
  const [command, ...commandArguments] = argv;

  if (command === undefined) {
    throw new Error('A spike command needs a program to run.');
  }

  const child = spawn(command, commandArguments, {
    detached: options.detached ?? false,
    stdio: options.stdio ?? 'ignore',
  });

  const outcome = new Promise<CommandOutcome>((resolve) => {
    child.once('error', (error) => {
      resolve({ kind: 'startFailed', error });
    });

    child.once('exit', (code) => {
      resolve({ code, kind: 'exit' });
    });
  });

  commandOutcomes.set(child, outcome);

  return child;
};

const outcomeOf = (child: ChildProcess): Promise<CommandOutcome> => {
  const outcome = commandOutcomes.get(child);

  if (outcome === undefined) {
    throw new Error('A spike command must be started before it is watched.');
  }

  return outcome;
};

const hasExited = (child: ChildProcess): boolean =>
  child.pid === undefined || child.exitCode !== null || child.signalCode !== null;

const waitForExit = async (child: ChildProcess): Promise<number | null> => {
  const outcome = await outcomeOf(child);

  if (outcome.kind === 'startFailed') {
    throw outcome.error;
  }

  return outcome.code;
};

export const runSpikeCommand = (argv: readonly string[]): Promise<number | null> =>
  waitForExit(startCommand(argv));

const stopCommand = async (child: ChildProcess): Promise<void> => {
  if (!hasExited(child)) {
    child.kill('SIGKILL');
  }

  await waitForExit(child).catch(() => undefined);
};

const markerExists = async (markerPath: string): Promise<boolean> => {
  try {
    await access(markerPath);

    return true;
  } catch {
    return false;
  }
};

export const waitForHolderReady = async (
  markerPath: string,
  watched: ChildProcess,
): Promise<void> => {
  const deadline = Date.now() + probeTimeoutMilliseconds;

  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- Each wait reads what the last one left.
    const ready = await markerExists(markerPath);

    if (ready) {
      return;
    }

    if (hasExited(watched)) {
      // oxlint-disable-next-line no-await-in-loop -- Each wait reads what the last one left.
      const exitCode = await waitForExit(watched);

      if (exitCode === osLockMarkerWriteExitCode) {
        throw new Error(`The lock holder could not write its readiness marker at ${markerPath}.`);
      }

      if (exitCode === osLockConflictExitCode) {
        throw new Error('The lock holder found the lock already held.');
      }

      throw new Error(`The watched process exited ${String(exitCode)} before the lock was taken.`);
    }

    // oxlint-disable-next-line no-await-in-loop -- Each wait reads what the last one left.
    await sleep(probePollMilliseconds);
  }

  throw new Error(`The lock holder did not write its readiness marker at ${markerPath}.`);
};

export const startHolder = (lockPath: string, markerPath: string): ChildProcess =>
  startCommand(sleepHolderArgv(lockPath, markerPath, true));

// A probe takes the lock and lets go of it at once. It is therefore not read-only: a launch that
// races the probe sees the conflict code.
export const readOsLockState = async (lockPath: string): Promise<OsLockState> => {
  const exitCode = await runSpikeCommand(osLockWrapperArgv(lockPath, ['true']));

  if (exitCode === osLockConflictExitCode) {
    return 'held';
  }

  if (exitCode === 0) {
    return 'free';
  }

  throw new Error(`The flock probe on ${lockPath} exited ${String(exitCode)}.`);
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

export const secondHolderRefused = async (
  lockPath: string,
  markerPath: string,
): Promise<number | null> => {
  const holder = startHolder(lockPath, markerPath);

  try {
    await waitForHolderReady(markerPath, holder);

    return await runSpikeCommand(osLockWrapperArgv(lockPath, ['true']));
  } finally {
    await stopCommand(holder);
  }
};

const holderPidPathFrom = (markerPath: string): string => `${markerPath}.holder-pid`;

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

const readHolderPid = async (holderPidPath: string): Promise<number | undefined> => {
  try {
    const text = await readFile(holderPidPath, 'utf8');
    const value = Number(text.trim());

    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
};

const stopHolderFromFile = async (holderPidPath: string): Promise<void> => {
  stopProcess(await readHolderPid(holderPidPath), 'SIGKILL');
};

export const startParentWithHolder = async (
  mode: 'abandon' | 'exit' | 'wait',
  lockPath: string,
  markerPath: string,
  holderPidPath: string,
): Promise<ParentHolder> => {
  const holderArgv = sleepHolderArgv(lockPath, markerPath, true);

  const parent = startCommand(
    [process.execPath, osLockParentFixturePath, mode, markerPath, holderPidPath, ...holderArgv],
    { detached: true, stdio: ['pipe', 'pipe', 'ignore'] },
  );

  try {
    return { holderPid: await readProcessId(parent), parent };
  } catch (error) {
    await stopGroup(parent, 0);
    await stopHolderFromFile(holderPidPath);

    throw error;
  }
};

export const holderOutlivesKilledParent = async (
  lockPath: string,
  markerPath: string,
): Promise<{ holderAlive: boolean; state: OsLockState }> => {
  const { parent, holderPid } = await startParentWithHolder(
    'wait',
    lockPath,
    markerPath,
    holderPidPathFrom(markerPath),
  );

  try {
    await waitForHolderReady(markerPath, parent);

    stopProcess(parent.pid, 'SIGKILL');
    await waitForExit(parent).catch(() => undefined);

    return {
      holderAlive: processState(holderPid) !== 'gone',
      state: await readOsLockState(lockPath),
    };
  } finally {
    stopProcess(holderPid, 'SIGKILL');
    stopProcess(parent.pid, 'SIGKILL');
    await waitForOsLockState(lockPath, 'free');
  }
};

export const lockFreesWhenEveryHolderIsGone = async (
  lockPath: string,
  markerPath: string,
): Promise<{ before: OsLockState; after: OsLockState }> => {
  const holder = startHolder(lockPath, markerPath);

  try {
    await waitForHolderReady(markerPath, holder);

    const before = await readOsLockState(lockPath);

    await stopCommand(holder);

    return { after: await waitForOsLockState(lockPath, 'free'), before };
  } finally {
    await stopCommand(holder);
  }
};

export const detachedChildKeepsLockAfterParentExit = async (
  lockPath: string,
  markerPath: string,
): Promise<{
  parentExitCode: number | null;
  stateBeforeParentExit: OsLockState;
  state: OsLockState;
}> => {
  const { parent, holderPid } = await startParentWithHolder(
    'exit',
    lockPath,
    markerPath,
    holderPidPathFrom(markerPath),
  );

  try {
    await waitForHolderReady(markerPath, parent);

    const stateBeforeParentExit = await readOsLockState(lockPath);

    parent.stdin?.end();

    const parentExitCode = await waitForExit(parent);

    return { parentExitCode, state: await readOsLockState(lockPath), stateBeforeParentExit };
  } finally {
    stopProcess(holderPid, 'SIGKILL');
    stopProcess(parent.pid, 'SIGKILL');
    await waitForOsLockState(lockPath, 'free');
  }
};

export const wrapperHoldsLockAcrossExec = async (
  lockPath: string,
  markerPath: string,
): Promise<{ secondExitCode: number | null; stateAfterKillingHolder: OsLockState }> => {
  const wrapper = startHolder(lockPath, markerPath);

  try {
    await waitForHolderReady(markerPath, wrapper);

    const secondExitCode = await runSpikeCommand(osLockWrapperArgv(lockPath, ['true']));

    await stopCommand(wrapper);

    return {
      secondExitCode,
      stateAfterKillingHolder: await waitForOsLockState(lockPath, 'free'),
    };
  } finally {
    await stopCommand(wrapper);
  }
};

export const supervisorWithoutFork = async (
  lockPath: string,
  markerPath: string,
): Promise<{ stateAfterSupervisorKilled: OsLockState; stateAfterGroupKilled: OsLockState }> => {
  const supervisor = startCommand(sleepHolderArgv(lockPath, markerPath, false), {
    detached: true,
  });

  try {
    await waitForHolderReady(markerPath, supervisor);

    stopProcess(supervisor.pid, 'SIGKILL');
    await waitForExit(supervisor).catch(() => undefined);

    const stateAfterSupervisorKilled = await readOsLockState(lockPath);

    signalGroup(supervisor, 'SIGKILL');

    return {
      stateAfterGroupKilled: await waitForOsLockState(lockPath, 'free'),
      stateAfterSupervisorKilled,
    };
  } finally {
    signalGroup(supervisor, 'SIGKILL');
    await stopCommand(supervisor);
  }
};

export const runSpike = async (directory: string): Promise<SpikeObservation[]> => {
  const lockPathOf = (name: string): string => join(directory, `${name}.lock`);
  const markerPathOf = (name: string): string => join(directory, `${name}.ready`);

  const secondExitCode = await secondHolderRefused(
    lockPathOf('second-holder'),
    markerPathOf('second-holder'),
  );

  const outlivedParent = await holderOutlivesKilledParent(
    lockPathOf('killed-parent'),
    markerPathOf('killed-parent'),
  );

  const everyHolderGone = await lockFreesWhenEveryHolderIsGone(
    lockPathOf('every-holder-gone'),
    markerPathOf('every-holder-gone'),
  );

  const detachedChild = await detachedChildKeepsLockAfterParentExit(
    lockPathOf('detached-child'),
    markerPathOf('detached-child'),
  );

  const acrossExec = await wrapperHoldsLockAcrossExec(
    lockPathOf('wrapper-exec'),
    markerPathOf('wrapper-exec'),
  );

  const supervisor = await supervisorWithoutFork(
    lockPathOf('supervisor'),
    markerPathOf('supervisor'),
  );

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
