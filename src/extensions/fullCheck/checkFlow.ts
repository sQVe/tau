import { join } from 'node:path';

import { listSavedLogs, saveCheckRecord } from '../../checkRecord/checkRecord.js';
import { decideReuse, sameReusableState } from '../../checkRecord/reuseDecision.js';
import type { CheckIdentity } from '../../checkRecord/reuseDecision.js';
import { errorMessage } from '../../errors.js';
import { readGitOutput } from '../../gitOutput.js';
import { repositoryFromRemote } from '../../repositoryRemote.js';
import { defaultLockPath, withFullCheckLock } from './queue.js';
import { readTail, runCheck } from './run.js';
import type { CheckResult } from './run.js';

export type Recorded<Verdict> = Verdict & { reused: boolean; recordError?: string };

export interface RunSettings {
  signal: AbortSignal | undefined;
  recordCommandGroup: (groupId: number) => Promise<void>;
  idleLimitMilliseconds: number | undefined;
  checksPath: string;
  separateStdout: boolean;
}

export interface LockContext {
  root: string;
  agentDirectory: string;
  repository: string;
  signal: AbortSignal | undefined;
  pollMilliseconds: number;
  notifyWaiting: (message: string) => void;
}

export const readRepository = async (root: string): Promise<string | undefined> => {
  const output = await readGitOutput(root, ['remote', 'get-url', 'origin']);

  return output === undefined ? undefined : repositoryFromRemote(output);
};

export const findReusedLog = async (
  root: string,
  identity: CheckIdentity,
  checksPath: string,
): Promise<(CheckResult & { reused: true }) | undefined> => {
  const decision = decideReuse(identity, await listSavedLogs(join(root, '.tau', checksPath)));

  if (decision.status === 'run') {
    return undefined;
  }

  const tail = await readTail(decision.logPath);

  return {
    passed: true,
    exitCode: 0,
    signal: null,
    idle: false,
    logPath: decision.logPath,
    tail,
    reused: true,
  };
};

// Runs the command and saves a record with the verdict of `settle` when its inputs did not change.
// Only a passing record is reused.
export const runAndRecord = async <Verdict extends { passed: boolean }>(
  root: string,
  identity: CheckIdentity,
  readIdentity: () => Promise<CheckIdentity>,
  settings: RunSettings,
  settle: (result: CheckResult) => Promise<Verdict>,
): Promise<Recorded<Verdict>> => {
  const result = await runCheck(
    root,
    identity.argv,
    settings.signal,
    settings.recordCommandGroup,
    settings.idleLimitMilliseconds,
    settings.separateStdout,
    settings.checksPath,
  );

  const verdict = await settle(result);

  // A missing record only disables reuse, so a failure to save it never changes the verdict.
  try {
    const after = await readIdentity();

    if (sameReusableState(identity, after)) {
      await saveCheckRecord(result.logPath, identity, verdict.passed);
    }
  } catch (error) {
    return { ...verdict, reused: false, recordError: errorMessage(error) };
  }

  return { ...verdict, reused: false };
};

// Full checks and mutation checks of one repository share a lock, since they share resources.
export const withRepositoryLock = <T>(
  context: LockContext,
  run: (recordCommandGroup: (groupId: number) => Promise<void>) => Promise<T>,
): Promise<T> =>
  withFullCheckLock(
    {
      lockPath: defaultLockPath(context.agentDirectory, context.repository),
      checkout: context.root,
      signal: context.signal,
      pollMilliseconds: context.pollMilliseconds,
      onWaiting: (holder) => {
        const holderName = holder === undefined ? 'another checkout' : holder.checkout;

        context.notifyWaiting(
          `Waiting for the full check or mutation check running in ${holderName} to finish.`,
        );
      },
    },
    run,
  );
