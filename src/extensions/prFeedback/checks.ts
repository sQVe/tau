import { Type } from 'typebox';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type { CommandRuntime } from '../../command.js';
import { runOutcome } from '../../github/github.js';
import type { Repository } from '../../github/github.js';
import { formatRepository } from '../../github/repositoryTargetDecisions.js';
import { describeSchemaProblem } from '../../schema.js';
import {
  boundChecks,
  checkListEvidence,
  commandGap,
  commandResult,
  failedCommandReason,
  failedLogEvidence,
  failedTrunkRuns,
  gapsOf,
  isFailing,
  isTrunkMatch,
  jobOf,
  logCharacterBudget,
  parseOutput,
  unreadableLinkGap,
} from './checkEvidence.js';
import type {
  Check,
  CheckGap,
  CheckItem,
  CheckListValidation,
  CommandResult,
  LogExcerpt,
  PullRequestChecks,
  TrunkMatch,
} from './checkEvidence.js';
import { readPullRequest } from './github.js';

interface TrunkEvidence {
  trunkMatches: TrunkMatch[];
  trunkGaps?: CheckGap[];
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

const trunkRunListSchema = Type.Array(
  Type.Object({
    databaseId: Type.Integer(),
    conclusion: Type.String(),
    headSha: Type.String(),
    url: Type.String(),
  }),
);

const trunkRunJobsSchema = Type.Object({
  jobs: Type.Array(Type.Object({ name: Type.String(), conclusion: Type.String() })),
});

const trunkRunLimit = 5;

const validateCheckList: CheckListValidation = (value) =>
  Value.Check(checkListSchema, value)
    ? { checks: value }
    : { problem: `printed unexpected output: ${describeSchemaProblem(checkListSchema, value)}` };

const readCheckList = async (runtime: CommandRuntime, repository: Repository, pr: number) => {
  const commandArguments = [
    'pr',
    'checks',
    String(pr),
    '--repo',
    formatRepository(repository),
    '--json',
    'name,bucket,link,workflow,state',
  ];

  const result = commandResult(commandArguments, await runOutcome(runtime, commandArguments));

  return checkListEvidence(result, validateCheckList);
};

const readFailedLog = async (
  runtime: CommandRuntime,
  repository: Repository,
  check: CheckItem,
  remainingCharacters: number,
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
    formatRepository(repository),
    '--job',
    job.job,
    '--log-failed',
  ];

  const result = commandResult(commandArguments, await runOutcome(runtime, commandArguments));

  return failedLogEvidence(check, result, remainingCharacters);
};

const outputEvidence = <Schema extends TSchema>(
  check: CheckItem,
  result: CommandResult,
  schema: Schema,
): { value: Static<Schema> } | { gap: CheckGap } => {
  if (result.code !== 0 || result.killed) {
    return { gap: commandGap(check.name, result, failedCommandReason(result)) };
  }

  const parsed = parseOutput(result.stdout, (value) =>
    Value.Check(schema, value)
      ? { value }
      : { problem: `printed unexpected output: ${describeSchemaProblem(schema, value)}` },
  );

  return 'problem' in parsed
    ? { gap: commandGap(check.name, result, `${result.command} ${parsed.problem}`) }
    : parsed;
};

const runListArguments = (repository: Repository, trunk: string, workflow: string) => [
  'run',
  'list',
  '--repo',
  formatRepository(repository),
  '--branch',
  trunk,
  '--workflow',
  workflow,
  '--all',
  '--limit',
  String(trunkRunLimit),
  '--json',
  'databaseId,conclusion,headSha,url',
];

const runJobsArguments = (repository: Repository, run: number) => [
  'run',
  'view',
  String(run),
  '--repo',
  formatRepository(repository),
  '--json',
  'jobs',
];

const createTrunkReader = (runtime: CommandRuntime, repository: Repository, trunk: string) => {
  const results = new Map<string, CommandResult>();

  const read = async (commandArguments: string[]) => {
    const key = commandArguments.join(' ');
    const cached = results.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const result = commandResult(commandArguments, await runOutcome(runtime, commandArguments));

    results.set(key, result);

    return result;
  };

  return async (check: CheckItem): Promise<TrunkEvidence> => {
    const listResult = await read(runListArguments(repository, trunk, check.workflow));
    const runs = outputEvidence(check, listResult, trunkRunListSchema);

    if ('gap' in runs) {
      return { trunkMatches: [], trunkGaps: [runs.gap] };
    }

    const trunkMatches: TrunkMatch[] = [];
    const trunkGaps: CheckGap[] = [];

    for (const run of failedTrunkRuns(runs.value)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One gh run view at a time, as for logs.
      const jobsResult = await read(runJobsArguments(repository, run.databaseId));
      const jobs = outputEvidence(check, jobsResult, trunkRunJobsSchema);

      if ('gap' in jobs) {
        trunkGaps.push(jobs.gap);
      } else if (isTrunkMatch(check.name, jobs.value.jobs)) {
        trunkMatches.push({ url: run.url, headSha: run.headSha });
      }
    }

    return trunkGaps.length === 0 ? { trunkMatches } : { trunkMatches, trunkGaps };
  };
};

type TrunkReader = ReturnType<typeof createTrunkReader>;

const readCheck = async (
  runtime: CommandRuntime,
  repository: Repository,
  check: CheckItem,
  evidence: { remainingCharacters: number; readTrunk: TrunkReader },
): Promise<Check> => {
  const { name, workflow, bucket, state, link } = check;
  const metadata = { name, workflow, bucket, state, link };

  if (!isFailing(check)) {
    return metadata;
  }

  const log = await readFailedLog(runtime, repository, check, evidence.remainingCharacters);

  if (jobOf(repository, link) === undefined) {
    return { ...metadata, ...log };
  }

  return { ...metadata, ...log, ...(await evidence.readTrunk(check)) };
};

// gh pr checks reads the live head, so a push during the read can mix in another head's checks.
const requireHead = async (
  runtime: CommandRuntime,
  repository: Repository,
  pr: number,
  head: string,
) => {
  const pullRequest = await readPullRequest(runtime, repository, pr);

  if (pullRequest.headRefOid !== head) {
    throw new Error(
      `The pull request head is ${pullRequest.headRefOid}, not ${head}. The checks may belong to another head. Read the pull request again.`,
    );
  }

  return pullRequest;
};

export const readChecks = async (
  runtime: CommandRuntime,
  repository: Repository,
  pull: { pr: number; head: string; trunk: string | undefined },
): Promise<PullRequestChecks> => {
  const { pr, head } = pull;
  const pullRequest = await requireHead(runtime, repository, pr, head);
  const readTrunk = createTrunkReader(runtime, repository, pull.trunk ?? pullRequest.baseRefName);

  const list = await readCheckList(runtime, repository, pr);

  await requireHead(runtime, repository, pr, head);

  if ('gap' in list) {
    return boundChecks({ pr, checks: [], gaps: [list.gap] }, repository, head);
  }

  const checks: Check[] = [];
  let remainingCharacters = logCharacterBudget;

  for (const check of list.checks) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One gh run view at a time, so many failing jobs start no burst of calls.
    const evidence = await readCheck(runtime, repository, check, {
      remainingCharacters,
      readTrunk,
    });

    checks.push(evidence);
    remainingCharacters -= evidence.log?.excerpt.length ?? 0;
  }

  const gaps = checks.flatMap((check) => gapsOf(check));

  return boundChecks({ pr, checks, gaps }, repository, head);
};
