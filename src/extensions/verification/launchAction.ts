import { basename, join } from 'node:path';

import type { VerificationTarget } from '../../config/verificationTargets.js';
import { createFreshTauDirectory } from '../../tauDirectory.js';
import type { RunRecord } from '../../verification/records.js';
import { runRecordVersion } from '../../verification/records.js';
import { verificationDirectoryName, writeRunRecord } from '../../verification/verification.js';
import { runCommand } from './command.js';
import type { CommandOutcome } from './command.js';
import type { RunFacts } from './runFacts.js';
import { stopRun } from './stopAction.js';

export interface LaunchContext {
  checkoutRoot: string;
  recordRoot: string;
  deadlineMilliseconds: number;
  signal: AbortSignal | undefined;
  target: string;
  commands: VerificationTarget;
  facts: RunFacts;
}

export type LaunchResult =
  | { status: 'ready'; run: string; directory: string }
  | {
      status: 'failed';
      run: string;
      directory: string;
      command: 'launch' | 'doctor';
      exitCode: number | null;
      logPath: string;
      stopped: boolean;
    };

const exitCodeOf = (outcome: CommandOutcome): number | null =>
  outcome.kind === 'exited' ? outcome.exitCode : null;

const commandResult = (outcome: CommandOutcome, logPath: string): RunRecord['launch'] => ({
  exitCode: exitCodeOf(outcome),
  logPath,
});

const failedResult = (
  run: string,
  directory: string,
  command: 'launch' | 'doctor',
  outcome: CommandOutcome,
  logPath: string,
  stopped: boolean,
): LaunchResult => ({
  status: 'failed',
  run,
  directory,
  command,
  exitCode: exitCodeOf(outcome),
  logPath: join(directory, logPath),
  stopped,
});

const runStep = (
  context: LaunchContext,
  directory: string,
  argv: readonly string[],
  logPath: string,
  environment: Readonly<Record<string, string>>,
): Promise<CommandOutcome> =>
  runCommand({
    argv,
    cwd: context.checkoutRoot,
    logPath: join(directory, logPath),
    environment,
    deadlineMilliseconds: context.deadlineMilliseconds,
    signal: context.signal,
  });

export const launchRun = async (context: LaunchContext): Promise<LaunchResult> => {
  const directory = await createFreshTauDirectory(
    context.recordRoot,
    verificationDirectoryName,
    `${context.target}-`,
  );

  const run = basename(directory);

  const environment = {
    TAU_VERIFICATION_RUN: run,
    TAU_VERIFICATION_DIRECTORY: directory,
  };

  const record: RunRecord = {
    version: runRecordVersion,
    run,
    target: context.target,
    head: context.facts.head,
    dirty: context.facts.dirty,
    platform: context.facts.platform,
    startedAt: new Date().toISOString(),
    treeAtLaunch: context.facts.tree,
    treeAtStop: null,
    launch: null,
    doctor: null,
    stop: null,
    items: [],
  };

  await writeRunRecord(directory, record);

  const launchOutcome = await runStep(
    context,
    directory,
    context.commands.launch,
    'launch.log',
    environment,
  );

  record.launch = commandResult(launchOutcome, 'launch.log');
  await writeRunRecord(directory, record);

  if (launchOutcome.kind === 'stopped') {
    const stop = await stopRun({
      checkoutRoot: context.checkoutRoot,
      directory,
      deadlineMilliseconds: context.deadlineMilliseconds,
      signal: undefined,
      run,
      readTarget: () => context.commands,
    });

    return failedResult(run, directory, 'launch', launchOutcome, 'launch.log', stop.stopped);
  }

  if (launchOutcome.kind !== 'exited' || launchOutcome.exitCode !== 0) {
    return failedResult(run, directory, 'launch', launchOutcome, 'launch.log', false);
  }

  const doctorOutcome = await runStep(
    context,
    directory,
    context.commands.doctor,
    'doctor.log',
    environment,
  );

  record.doctor = commandResult(doctorOutcome, 'doctor.log');
  await writeRunRecord(directory, record);

  if (doctorOutcome.kind !== 'exited' || doctorOutcome.exitCode !== 0) {
    return failedResult(run, directory, 'doctor', doctorOutcome, 'doctor.log', false);
  }

  return { status: 'ready', run, directory };
};
