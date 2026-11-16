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
import { readRunRecordOrThrow, runDirectory } from './runFacts.js';

export interface StopContext {
  root: string;
  deadlineMilliseconds: number;
  signal: AbortSignal | undefined;
  run: string;
  readTarget: (name: string) => VerificationTarget;
}

export interface StopResult {
  run: string;
  directory: string;
  exitCode: number | null;
  logPath: string;
  freshness: Freshness;
}

const exitCodeOf = (outcome: CommandOutcome): number | null =>
  outcome.kind === 'exited' ? outcome.exitCode : null;

export const stopRun = async (context: StopContext): Promise<StopResult> => {
  const directory = runDirectory(context.root, context.run);
  const record = await readRunRecordOrThrow(directory, context.run);
  const decision = decideStop(record);

  if (decision.kind === 'refuse') {
    throw new Error(decision.reason);
  }

  const commands = context.readTarget(record.target);

  const outcome = await runCommand({
    argv: commands.stop,
    cwd: context.root,
    logPath: join(directory, 'stop.log'),
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

  const state = await readCheckState(context.root);
  const treeAtStop = state.tree;

  const updated: RunRecord = {
    ...record,
    stop: { exitCode: exitCodeOf(outcome), logPath: 'stop.log' },
    treeAtStop,
  };

  await writeRunRecord(directory, updated);

  return {
    run: record.run,
    directory,
    exitCode: exitCodeOf(outcome),
    logPath: join(directory, 'stop.log'),
    freshness: decideFreshness(updated, treeAtStop),
  };
};
