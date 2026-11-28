import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readCheckState } from '../../checkRecord/identity.js';
import type { VerificationTarget } from '../../config/verificationTargets.js';
import { decideFreshness } from '../../verification/freshness.js';
import type { Freshness } from '../../verification/freshness.js';
import type { RunRecord } from '../../verification/records.js';
import { writeRunRecord } from '../../verification/verification.js';
import { runCommand } from './command.js';
import type { CommandOutcome } from './command.js';
import { decideStop } from './runDecision.js';
import { readRunRecordOrThrow } from './runFacts.js';

export interface StopContext {
  checkoutRoot: string;
  directory: string;
  deadlineMilliseconds: number;
  signal: AbortSignal | undefined;
  run: string;
  readTarget: (name: string) => VerificationTarget;
}

export interface StopResult {
  stopped: boolean;
  run: string;
  directory: string;
  exitCode: number | null;
  logPath: string;
  freshness: Freshness;
}

const exitCodeOf = (outcome: CommandOutcome): number | null =>
  outcome.kind === 'exited' ? outcome.exitCode : null;

const stopResult = (
  record: RunRecord,
  directory: string,
  exitCode: number | null,
  logPath: string,
  currentTree: string | null,
): StopResult => ({
  stopped: exitCode === 0,
  run: record.run,
  directory,
  exitCode,
  logPath,
  freshness: decideFreshness(record, currentTree),
});

const stopLogName = (directory: string): string => {
  for (let attempt = 1; ; attempt += 1) {
    const name = attempt === 1 ? 'stop.log' : `stop-${attempt}.log`;

    if (!existsSync(join(directory, name))) {
      return name;
    }
  }
};

export const stopRun = async (context: StopContext): Promise<StopResult> => {
  const { directory } = context;
  const record = await readRunRecordOrThrow(directory, context.run);
  const decision = decideStop(record);

  if (decision.kind === 'refuse') {
    throw new Error(decision.reason);
  }

  const commands = context.readTarget(record.target);
  const logName = stopLogName(directory);
  const logPath = join(directory, logName);

  const outcome = await runCommand({
    argv: commands.stop,
    cwd: context.checkoutRoot,
    logPath,
    environment: {
      TAU_VERIFICATION_RUN: record.run,
      TAU_VERIFICATION_DIRECTORY: directory,
    },
    deadlineMilliseconds: context.deadlineMilliseconds,
    signal: context.signal,
  });

  if (outcome.kind === 'stopped' && outcome.reason === 'cancelled') {
    throw new Error('The stop was cancelled. Call stop again to stop the run.');
  }

  if (outcome.kind === 'notStarted') {
    throw new Error(
      `The stop for run ${record.run} could not start: ${outcome.message}. See ${logPath}. Call stop again after fixing the command.`,
    );
  }

  const exitCode = exitCodeOf(outcome);

  if (exitCode !== 0) {
    return stopResult(record, directory, exitCode, logPath, null);
  }

  const state = await readCheckState(context.checkoutRoot);
  const treeAtStop = state.tree;

  const updated: RunRecord = {
    ...record,
    stop: { exitCode, logPath: logName },
    treeAtStop,
  };

  await writeRunRecord(directory, updated);

  return stopResult(updated, directory, exitCode, logPath, treeAtStop);
};
