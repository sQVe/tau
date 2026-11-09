import { join } from 'node:path';

import { listSavedLogs, saveCheckRecord } from '../../checkRecord/checkRecord.js';
import { readCheckIdentity } from '../../checkRecord/identity.js';
import { decideReuse, sameReusableState } from '../../checkRecord/reuseDecision.js';
import type { CheckIdentity } from '../../checkRecord/reuseDecision.js';
import type { CommandRuntime, Exec } from '../../command.js';
import type { LockScope } from '../../config/repositoryCommand.js';
import { errorMessage } from '../../errors.js';
import type { Repository } from '../../github/github.js';
import { readOriginRepository } from '../../github/repositoryTarget.js';
import { checkoutLockPath, repositoryLockPath, withFullCheckLock } from './queue.js';
import { readTail, runCheck } from './run.js';
import type { CheckOutput, CheckResult } from './run.js';

export type Recorded<Verdict> = Verdict & { reused: boolean; recordError?: string };

export interface CheckPlan {
  name: string;
  root: string;
  argv: string[];
  exec: Exec;
  agentDirectory: string;
  lockScope: LockScope;
  checksPath: string;
  output: CheckOutput;
  idleLimitMilliseconds: number;
  pollMilliseconds: number;
  signal: AbortSignal | undefined;
  notifyWaiting: (message: string) => void;
}

export interface CheckPolicy<Verdict extends { passed: boolean }> {
  settle: (result: CheckResult) => Promise<Verdict>;
  reuse: (saved: CheckResult) => Promise<(Verdict & { reused: true }) | undefined>;
}

const readRepository = async (runtime: CommandRuntime): Promise<Repository | undefined> => {
  const origin = await readOriginRepository(runtime);

  return origin.status === 'named' ? origin.repository : undefined;
};

// The lock is shared by every checkout of `owner/name`, whatever the host.
const repositoryLockKey = ({ owner, name }: Repository): string => `${owner}/${name}`;

const findReusedLog = async (
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

const withCheckLock = <T>(
  plan: CheckPlan,
  lockPath: string,
  run: (recordCommandGroup: (groupId: number) => Promise<void>) => Promise<T>,
): Promise<T> =>
  withFullCheckLock(
    {
      lockPath,
      checkout: plan.root,
      signal: plan.signal,
      pollMilliseconds: plan.pollMilliseconds,
      onWaiting: (holder) => {
        const holderName = holder === undefined ? 'another checkout' : holder.checkout;

        plan.notifyWaiting(
          `Waiting for the full check or mutation check running in ${holderName} to finish.`,
        );
      },
    },
    run,
  );

const noRepositoryMessage = (name: string): string =>
  `This checkout has an origin remote that does not name an owner/name repository, so the ${name} has no lock to share with other checkouts of the repository. Remove fullCheck.lockScope from .pi/tau.json to lock this checkout only.`;

const readLockPath = async (plan: CheckPlan): Promise<string> => {
  if (plan.lockScope === 'checkout') {
    return checkoutLockPath(plan.agentDirectory, plan.root);
  }

  const repository = await readRepository({
    exec: plan.exec,
    cwd: plan.root,
    signal: plan.signal,
  });

  if (repository === undefined) {
    throw new Error(noRepositoryMessage(plan.name));
  }

  return repositoryLockPath(plan.agentDirectory, repositoryLockKey(repository));
};

const reuseSaved = async <Verdict extends { passed: boolean }>(
  plan: CheckPlan,
  policy: CheckPolicy<Verdict>,
  identity: CheckIdentity,
): Promise<Recorded<Verdict> | undefined> => {
  const saved = await findReusedLog(plan.root, identity, plan.checksPath);

  if (saved === undefined) {
    return undefined;
  }

  return policy.reuse(saved);
};

const runWithRecord = async <Verdict extends { passed: boolean }>(
  plan: CheckPlan,
  policy: CheckPolicy<Verdict>,
  recordCommandGroup: (groupId: number) => Promise<void>,
): Promise<Recorded<Verdict>> => {
  const identity = await readCheckIdentity(plan.root, plan.argv);
  const reused = await reuseSaved(plan, policy, identity);

  if (reused !== undefined) {
    return reused;
  }

  const result = await runCheck({
    root: plan.root,
    argv: identity.argv,
    signal: plan.signal,
    onStarted: recordCommandGroup,
    idleLimitMilliseconds: plan.idleLimitMilliseconds,
    output: plan.output,
    checksPath: plan.checksPath,
  });

  const verdict = await policy.settle(result);

  // A missing record only disables reuse, so a failure to save it never changes the verdict.
  try {
    const after = await readCheckIdentity(plan.root, plan.argv);

    if (sameReusableState(identity, after)) {
      await saveCheckRecord(result.logPath, identity, verdict.passed);
    }
  } catch (error) {
    return { ...verdict, reused: false, recordError: errorMessage(error) };
  }

  return { ...verdict, reused: false };
};

export const executeRecordedCheck = async <Verdict extends { passed: boolean }>(
  plan: CheckPlan,
  policy: CheckPolicy<Verdict>,
): Promise<Recorded<Verdict>> => {
  const lockPath = await readLockPath(plan);
  const before = await readCheckIdentity(plan.root, plan.argv);
  const reusedBeforeWaiting = await reuseSaved(plan, policy, before);

  if (reusedBeforeWaiting !== undefined) {
    return reusedBeforeWaiting;
  }

  return withCheckLock(plan, lockPath, (recordCommandGroup) =>
    runWithRecord(plan, policy, recordCommandGroup),
  );
};
