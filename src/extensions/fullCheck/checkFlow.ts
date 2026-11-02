import { join } from 'node:path';

import { listSavedLogs, saveCheckRecord } from '../../checkRecord/checkRecord.js';
import { readCheckIdentity } from '../../checkRecord/identity.js';
import { decideReuse, sameReusableState } from '../../checkRecord/reuseDecision.js';
import type { CheckIdentity } from '../../checkRecord/reuseDecision.js';
import type { CommandRuntime, Exec } from '../../command.js';
import { errorMessage } from '../../errors.js';
import type { Repository } from '../../github/github.js';
import { readOriginRepository } from '../../github/repositoryTarget.js';
import { defaultLockPath, withFullCheckLock } from './queue.js';
import { readTail, runCheck } from './run.js';
import type { CheckOutput, CheckResult } from './run.js';

export type Recorded<Verdict> = Verdict & { reused: boolean; recordError?: string };

export interface CheckPlan {
  name: string;
  root: string;
  argv: string[];
  exec: Exec;
  agentDirectory: string;
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

interface RunSettings {
  signal: AbortSignal | undefined;
  recordCommandGroup: (groupId: number) => Promise<void>;
  idleLimitMilliseconds: number;
  checksPath: string;
  output: CheckOutput;
}

interface LockContext {
  root: string;
  agentDirectory: string;
  repository: string;
  signal: AbortSignal | undefined;
  pollMilliseconds: number;
  notifyWaiting: (message: string) => void;
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

// Runs the command and saves a record with the verdict of `settle` when its inputs did not change.
// Only a passing record is reused.
const runAndRecord = async <Verdict extends { passed: boolean }>(
  root: string,
  identity: CheckIdentity,
  readIdentity: () => Promise<CheckIdentity>,
  settings: RunSettings,
  settle: (result: CheckResult) => Promise<Verdict>,
): Promise<Recorded<Verdict>> => {
  const result = await runCheck({
    root,
    argv: identity.argv,
    signal: settings.signal,
    onStarted: settings.recordCommandGroup,
    idleLimitMilliseconds: settings.idleLimitMilliseconds,
    output: settings.output,
    checksPath: settings.checksPath,
  });

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
const withRepositoryLock = <T>(
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

const noRepositoryMessage = (name: string): string =>
  `This checkout has an origin remote that does not name an owner/name repository, so the ${name} has no lock to share with other checkouts of the repository.`;

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

  return runAndRecord(
    plan.root,
    identity,
    () => readCheckIdentity(plan.root, plan.argv),
    {
      signal: plan.signal,
      recordCommandGroup,
      idleLimitMilliseconds: plan.idleLimitMilliseconds,
      checksPath: plan.checksPath,
      output: plan.output,
    },
    policy.settle,
  );
};

export const executeRecordedCheck = async <Verdict extends { passed: boolean }>(
  plan: CheckPlan,
  policy: CheckPolicy<Verdict>,
): Promise<Recorded<Verdict>> => {
  const repository = await readRepository({
    exec: plan.exec,
    cwd: plan.root,
    signal: plan.signal,
  });

  if (repository === undefined) {
    throw new Error(noRepositoryMessage(plan.name));
  }

  const before = await readCheckIdentity(plan.root, plan.argv);
  const reusedBeforeWaiting = await reuseSaved(plan, policy, before);

  if (reusedBeforeWaiting !== undefined) {
    return reusedBeforeWaiting;
  }

  return withRepositoryLock(
    {
      root: plan.root,
      agentDirectory: plan.agentDirectory,
      repository: repositoryLockKey(repository),
      signal: plan.signal,
      pollMilliseconds: plan.pollMilliseconds,
      notifyWaiting: plan.notifyWaiting,
    },
    (recordCommandGroup) => runWithRecord(plan, policy, recordCommandGroup),
  );
};
