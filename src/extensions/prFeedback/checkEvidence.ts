import type { GhOutcome, Repository } from '../../github/github.js';
import { formatRepository } from '../../github/repositoryTargetDecisions.js';

export interface CheckItem {
  name: string;
  workflow: string;
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
  state: string;
  link: string;
}

export interface CheckGap {
  check: string | null;
  command: string | null;
  code: number | null;
  stderr: string | null;
  reason: string;
  omittedStderrCharacters?: number;
}

export interface LogExcerpt {
  excerpt: string;
  omittedLines: number;
  // Characters cut from the start of the first kept line.
  omittedCharacters?: number;
  budgetLimited?: true;
  command?: string;
}

export interface TrunkMatch {
  url: string;
  headSha: string;
}

export interface TrunkRun {
  databaseId: number;
  conclusion: string;
  headSha: string;
  url: string;
}

export interface TrunkJob {
  name: string;
  conclusion: string;
}

export type Check = CheckItem & {
  log?: LogExcerpt;
  gap?: CheckGap;
  trunkMatches?: TrunkMatch[];
  trunkGaps?: CheckGap[];
};

interface CheckListGap extends CheckGap {
  kind: 'truncatedList';
  list: 'checks' | 'gaps';
  kept: number;
  total: number;
}

export interface PullRequestChecks {
  pr: number;
  checks: Check[];
  gaps: (CheckGap | CheckListGap)[];
}

export interface CommandResult {
  command: string;
  code: number;
  killed: boolean;
  stdout: string;
  stderr: string;
}

// Checks parsed JSON against the shape a gh command prints, and names the problem when it differs.
export type OutputValidation<Parsed> = (value: unknown) => Parsed | { problem: string };

export type CheckListValidation = OutputValidation<{ checks: CheckItem[] }>;

const excerptLineLimit = 200;
const excerptCharacterLimit = 20_000;
const outputPreviewLength = 200;
const stderrCharacterLimit = 2000;
const resultCharacterLimit = 40_000;

export const logCharacterBudget = 30_000;

// gh pr checks exits 1 while a check fails and 8 while one is pending, and still prints the list.
const failingChecksExitCode = 1;
const pendingChecksExitCode = 8;
const listedExitCodes = new Set([0, failingChecksExitCode, pendingChecksExitCode]);

const jobLinkPattern = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/u;

const shellSafeArgument = /^[\w./:=,@%+-]+$/u;

// Quotes an argument for a POSIX shell, so a caller can run the returned command as printed.
const quoteArgument = (argument: string) =>
  shellSafeArgument.test(argument) ? argument : `'${argument.replaceAll("'", String.raw`'\''`)}'`;

const formatCommand = (commandArguments: readonly string[]) =>
  ['gh', ...commandArguments].map((argument) => quoteArgument(argument)).join(' ');

export const commandResult = (
  commandArguments: readonly string[],
  outcome: GhOutcome,
): CommandResult => ({
  command: formatCommand(commandArguments),
  code: outcome.exitCode,
  killed: outcome.cancelled,
  stdout: outcome.stdout,
  stderr: outcome.stderr,
});

export const commandGap = (
  check: string | null,
  result: CommandResult,
  reason: string,
): CheckGap => {
  const stderr = result.stderr.trim();

  const gap: CheckGap = {
    check,
    command: result.command,
    code: result.code,
    stderr: stderr.slice(0, stderrCharacterLimit),
    reason,
  };

  if (stderr.length > stderrCharacterLimit) {
    gap.omittedStderrCharacters = stderr.length - stderrCharacterLimit;
  }

  return gap;
};

export const failedCommandReason = (result: CommandResult): string =>
  result.killed ? `${result.command} was stopped.` : `${result.command} failed.`;

export const parseOutput = <Parsed>(
  stdout: string,
  validate: OutputValidation<Parsed>,
): Parsed | { problem: string } => {
  if (stdout.trim() === '') {
    return { problem: 'printed no output' };
  }

  let value: unknown;

  try {
    value = JSON.parse(stdout);
  } catch {
    return { problem: `printed output that is not JSON: ${stdout.slice(0, outputPreviewLength)}` };
  }

  return validate(value);
};

// Exit 1 can also mean gh failed, so only the output tells a failing check from a failing gh.
export const checkListEvidence = (
  result: CommandResult,
  validate: CheckListValidation,
): { checks: CheckItem[] } | { gap: CheckGap } => {
  if (result.killed) {
    return { gap: commandGap(null, result, failedCommandReason(result)) };
  }

  if (!listedExitCodes.has(result.code)) {
    return { gap: commandGap(null, result, `${result.command} exited with code ${result.code}.`) };
  }

  const parsed = parseOutput(result.stdout, validate);

  if ('problem' in parsed) {
    return { gap: commandGap(null, result, `${result.command} ${parsed.problem}`) };
  }

  if (parsed.checks.length === 0) {
    return { gap: commandGap(null, result, 'The pull request has no checks.') };
  }

  return { checks: parsed.checks };
};

// Keeps the last lines that fit both limits. A last line longer than the character limit keeps
// its end.
const boundedExcerpt = (log: string, characterLimit: number): LogExcerpt => {
  const lines = log.replace(/\n+$/u, '').split('\n');

  if (characterLimit === 0) {
    return { excerpt: '', omittedLines: lines.length };
  }

  const kept: string[] = [];
  let length = 0;

  for (const line of lines.slice(-excerptLineLimit).toReversed()) {
    length += line.length + (kept.length === 0 ? 0 : 1);

    if (length > characterLimit) {
      break;
    }

    kept.unshift(line);
  }

  if (kept.length === 0) {
    const lastLine = lines.at(-1) ?? '';

    return {
      excerpt: lastLine.slice(-characterLimit),
      omittedLines: lines.length - 1,
      omittedCharacters: lastLine.length - characterLimit,
    };
  }

  return { excerpt: kept.join('\n'), omittedLines: lines.length - kept.length };
};

export const gapsOf = (check: Check): CheckGap[] => [
  ...(check.gap === undefined ? [] : [check.gap]),
  ...(check.trunkGaps ?? []),
];

const serializedSize = (result: PullRequestChecks) => JSON.stringify(result, null, 2).length;

const checksRecoveryCommand = (repository: Repository, head: string) => {
  const commitPath = `repos/${repository.owner}/${repository.name}/commits/${head}`;

  const read = (endpoint: string) =>
    formatCommand([
      'api',
      '--hostname',
      repository.host,
      `${commitPath}/${endpoint}`,
      '--paginate',
    ]);

  return `${read('check-runs')} && ${read('status')}`;
};

export const boundChecks = (
  full: PullRequestChecks,
  repository: Repository,
  head: string,
): PullRequestChecks => {
  if (serializedSize(full) <= resultCharacterLimit) {
    return full;
  }

  const hasChecks = full.checks.length > 0;
  const list = hasChecks ? 'checks' : 'gaps';
  const total = hasChecks ? full.checks.length : full.gaps.length;
  const command = checksRecoveryCommand(repository, head);

  const gap: CheckListGap = {
    kind: 'truncatedList',
    list,
    kept: 0,
    total,
    check: null,
    command,
    code: null,
    stderr: null,
    reason: 'The serialized result limit omitted evidence. Run the command to read it in full.',
  };

  const result: PullRequestChecks = { pr: full.pr, checks: [], gaps: [gap] };

  if (serializedSize(result) > resultCharacterLimit) {
    throw new Error('The checks recovery command exceeds the result character limit.');
  }

  for (const check of full.checks) {
    const previousGapCount = result.gaps.length;

    result.checks.push(check);
    gap.kept += 1;

    result.gaps.push(...gapsOf(check));

    if (serializedSize(result) > resultCharacterLimit) {
      result.checks.pop();
      result.gaps.splice(previousGapCount);
      gap.kept -= 1;

      break;
    }
  }

  return result;
};

export const isFailing = (check: CheckItem): boolean =>
  check.bucket === 'fail' || check.bucket === 'cancel';

export const failedTrunkRuns = (runs: TrunkRun[]): TrunkRun[] =>
  runs.filter((run) => run.conclusion === 'failure');

// A trunk run matches a check when a job with exactly the check's name failed in it.
export const isTrunkMatch = (checkName: string, jobs: TrunkJob[]): boolean =>
  jobs.some((job) => job.name === checkName && job.conclusion === 'failure');

const sameRepository = (repository: Repository, host: string, owner: string, name: string) =>
  formatRepository(repository).toLowerCase() === `${host}/${owner}/${name}`.toLowerCase();

export const jobOf = (
  repository: Repository,
  link: string,
): { run: string; job: string } | undefined => {
  const [, host = '', owner = '', name = '', run = '', job = ''] = jobLinkPattern.exec(link) ?? [];

  return sameRepository(repository, host, owner, name) ? { run, job } : undefined;
};

export const unreadableLinkGap = (repository: Repository, check: CheckItem): CheckGap => ({
  check: check.name,
  command: null,
  code: null,
  stderr: null,
  reason: `The link "${check.link}" is not a GitHub Actions job of ${formatRepository(repository)}, so its log was not read.`,
});

const omitsText = (excerpt: LogExcerpt) =>
  excerpt.omittedLines > 0 || excerpt.omittedCharacters !== undefined;

export const failedLogEvidence = (
  check: CheckItem,
  result: CommandResult,
  remainingCharacters: number,
): { log: LogExcerpt } | { gap: CheckGap } => {
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

  const excerpt = boundedExcerpt(result.stdout, excerptCharacterLimit);

  if (excerpt.excerpt.length <= remainingCharacters) {
    return { log: omitsText(excerpt) ? { ...excerpt, command: result.command } : excerpt };
  }

  return {
    log: {
      ...boundedExcerpt(result.stdout, remainingCharacters),
      budgetLimited: true,
      command: result.command,
    },
  };
};
