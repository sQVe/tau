import { Type } from 'typebox';
import { Value } from 'typebox/value';

import {
  checkListEvidence,
  failedLogEvidence,
  isFailing,
  jobOf,
  repositoryName,
  unreadableLinkGap,
} from './checkEvidence.js';
import type {
  CheckGap,
  CheckItem,
  CheckListValidation,
  CommandResult,
  LogExcerpt,
} from './checkEvidence.js';
import { describeProblem, readPullRequest } from './github.js';
import type { Repository, Runtime } from './github.js';

type Check = CheckItem & { log?: LogExcerpt; gap?: CheckGap };

export interface PullRequestChecks {
  pr: number;
  checks: Check[];
  gaps: CheckGap[];
}

const checkListSchema = Type.Array(
  Type.Object({
    name: Type.String(),
    workflow: Type.String(),
    bucket: Type.Union([
      Type.Literal('pass'),
      Type.Literal('fail'),
      Type.Literal('pending'),
      Type.Literal('skipping'),
      Type.Literal('cancel'),
    ]),
    state: Type.String(),
    link: Type.String(),
  }),
);

const validateCheckList: CheckListValidation = (value) =>
  Value.Check(checkListSchema, value)
    ? { checks: value }
    : { problem: `printed unexpected output: ${describeProblem(checkListSchema, value)}` };

const runGh = async (runtime: Runtime, commandArguments: string[]): Promise<CommandResult> => {
  const result = await runtime.exec('gh', commandArguments, {
    cwd: runtime.cwd,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });

  return { command: ['gh', ...commandArguments].join(' '), ...result };
};

const readCheckList = async (
  runtime: Runtime,
  repository: Repository,
  pr: number,
): Promise<{ checks: CheckItem[] } | { gap: CheckGap }> => {
  const commandArguments = [
    'pr',
    'checks',
    String(pr),
    '--repo',
    repositoryName(repository),
    '--json',
    'name,bucket,link,workflow,state',
  ];

  const result = await runGh(runtime, commandArguments);

  return checkListEvidence(result, validateCheckList);
};

const readFailedLog = async (
  runtime: Runtime,
  repository: Repository,
  check: CheckItem,
): Promise<{ log: LogExcerpt } | { gap: CheckGap }> => {
  const job = jobOf(repository, check.link);

  if (job === undefined) {
    return { gap: unreadableLinkGap(repository, check) };
  }

  const commandArguments = [
    'run',
    'view',
    job.run,
    '--repo',
    repositoryName(repository),
    '--job',
    job.job,
    '--log-failed',
  ];

  const result = await runGh(runtime, commandArguments);

  return failedLogEvidence(check, result);
};

const readCheck = async (
  runtime: Runtime,
  repository: Repository,
  check: CheckItem,
): Promise<Check> => {
  const { name, workflow, bucket, state, link } = check;
  const metadata = { name, workflow, bucket, state, link };

  if (!isFailing(check)) {
    return metadata;
  }

  return { ...metadata, ...(await readFailedLog(runtime, repository, check)) };
};

// gh pr checks reads the live head, so a push during the read can mix in another head's checks.
const requireHead = async (runtime: Runtime, repository: Repository, pr: number, head: string) => {
  const pullRequest = await readPullRequest(runtime, repository, pr);

  if (pullRequest.headRefOid !== head) {
    throw new Error(
      `The pull request head is ${pullRequest.headRefOid}, not ${head}. The checks may belong to another head. Read the pull request again.`,
    );
  }
};

// Reads the checks of a pull request at head and the failed-step logs of its failing jobs. Writes
// nothing. Returns a gap for each piece of evidence it could not read instead of failing, and
// throws when the head is not head before or after the check list.
export const readChecks = async (
  runtime: Runtime,
  repository: Repository,
  pull: { pr: number; head: string },
): Promise<PullRequestChecks> => {
  const { pr, head } = pull;

  await requireHead(runtime, repository, pr, head);

  const list = await readCheckList(runtime, repository, pr);

  await requireHead(runtime, repository, pr, head);

  if ('gap' in list) {
    return { pr, checks: [], gaps: [list.gap] };
  }

  const checks: Check[] = [];

  for (const check of list.checks) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One gh run view at a time, so many failing jobs start no burst of calls.
    checks.push(await readCheck(runtime, repository, check));
  }

  const gaps = checks.flatMap((check) => (check.gap === undefined ? [] : [check.gap]));

  return { pr, checks, gaps };
};
