import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { describeProblem, readPullRequest } from './github.js';
import type { Repository, Runtime } from './github.js';

interface CheckGap {
  check: string | null;
  command: string | null;
  code: number | null;
  stderr: string | null;
  reason: string;
}

interface LogExcerpt {
  excerpt: string;
  omittedLines: number;
}

export interface PullRequestChecks {
  pr: number;
  checks: Check[];
  gaps: CheckGap[];
}

interface CommandResult {
  command: string;
  code: number;
  killed: boolean;
  stdout: string;
  stderr: string;
}

const excerptLineLimit = 200;
const excerptCharacterLimit = 20_000;
const outputPreviewLength = 200;

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

type CheckItem = Static<typeof checkListSchema>[number];

type Check = Static<typeof checkListSchema>[number] & { log?: LogExcerpt; gap?: CheckGap };

const jobLinkPattern = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/u;

const repositoryName = (repository: Repository) =>
  `${repository.host}/${repository.owner}/${repository.name}`;

const runGh = async (runtime: Runtime, commandArguments: string[]): Promise<CommandResult> => {
  const result = await runtime.exec('gh', commandArguments, {
    cwd: runtime.cwd,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });

  return { command: ['gh', ...commandArguments].join(' '), ...result };
};

const commandGap = (check: string | null, result: CommandResult, reason: string): CheckGap => ({
  check,
  command: result.command,
  code: result.code,
  stderr: result.stderr.trim(),
  reason,
});

const failedCommandReason = (result: CommandResult) =>
  result.killed ? `${result.command} was stopped.` : `${result.command} failed.`;

const parseCheckList = (stdout: string): { checks: CheckItem[] } | { problem: string } => {
  if (stdout.trim() === '') {
    return { problem: 'printed no output' };
  }

  let value: unknown;

  try {
    value = JSON.parse(stdout);
  } catch {
    return { problem: `printed output that is not JSON: ${stdout.slice(0, outputPreviewLength)}` };
  }

  if (!Value.Check(checkListSchema, value)) {
    return { problem: `printed unexpected output: ${describeProblem(checkListSchema, value)}` };
  }

  return { checks: value };
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

  if (result.killed) {
    return { gap: commandGap(null, result, failedCommandReason(result)) };
  }

  // gh pr checks exits 1 while a check fails and 8 while one is pending, and still prints the
  // list. Only its output shows whether it failed.
  const parsed = parseCheckList(result.stdout);

  if ('problem' in parsed) {
    return { gap: commandGap(null, result, `${result.command} ${parsed.problem}`) };
  }

  const { checks } = parsed;

  if (checks.length === 0) {
    return { gap: commandGap(null, result, 'The pull request has no checks.') };
  }

  return { checks };
};

// Keeps the last lines that fit both limits. A last line longer than the character limit keeps
// its end.
const boundedExcerpt = (log: string): LogExcerpt => {
  const lines = log.replace(/\n+$/u, '').split('\n');
  const kept: string[] = [];
  let length = 0;

  for (const line of lines.slice(-excerptLineLimit).toReversed()) {
    length += line.length + (kept.length === 0 ? 0 : 1);

    if (length > excerptCharacterLimit) {
      break;
    }

    kept.unshift(line);
  }

  if (kept.length === 0) {
    const lastLine = lines.at(-1) ?? '';

    return { excerpt: lastLine.slice(-excerptCharacterLimit), omittedLines: lines.length - 1 };
  }

  return { excerpt: kept.join('\n'), omittedLines: lines.length - kept.length };
};

const isFailing = (check: CheckItem) => check.bucket === 'fail' || check.bucket === 'cancel';

const sameRepository = (repository: Repository, host: string, owner: string, name: string) =>
  repositoryName(repository).toLowerCase() === `${host}/${owner}/${name}`.toLowerCase();

const jobOf = (repository: Repository, link: string) => {
  const [, host = '', owner = '', name = '', run = '', job = ''] = jobLinkPattern.exec(link) ?? [];

  return sameRepository(repository, host, owner, name) ? { run, job } : undefined;
};

const readFailedLog = async (
  runtime: Runtime,
  repository: Repository,
  check: CheckItem,
): Promise<{ log: LogExcerpt } | { gap: CheckGap }> => {
  const job = jobOf(repository, check.link);

  if (job === undefined) {
    return {
      gap: {
        check: check.name,
        command: null,
        code: null,
        stderr: null,
        reason: `The link "${check.link}" is not a GitHub Actions job of ${repositoryName(repository)}, so its log was not read.`,
      },
    };
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

  if (result.code !== 0 || result.killed) {
    return { gap: commandGap(check.name, result, failedCommandReason(result)) };
  }

  if (result.stdout.trim() === '') {
    return {
      gap: commandGap(
        check.name,
        result,
        'The failed-step log is empty. A cancelled job may have none.',
      ),
    };
  }

  return { log: boundedExcerpt(result.stdout) };
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
