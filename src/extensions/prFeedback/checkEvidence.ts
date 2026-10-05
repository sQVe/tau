import type { Repository } from './github.js';

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
}

export interface LogExcerpt {
  excerpt: string;
  omittedLines: number;
}

export interface CommandResult {
  command: string;
  code: number;
  killed: boolean;
  stdout: string;
  stderr: string;
}

// Checks parsed JSON against the shape gh pr checks prints, and names the problem when it differs.
export type CheckListValidation = (value: unknown) => { checks: CheckItem[] } | { problem: string };

const excerptLineLimit = 200;
const excerptCharacterLimit = 20_000;
const outputPreviewLength = 200;

// gh pr checks exits 1 while a check fails and 8 while one is pending, and still prints the list.
const failingChecksExitCode = 1;
const pendingChecksExitCode = 8;
const listedExitCodes = new Set([0, failingChecksExitCode, pendingChecksExitCode]);

const jobLinkPattern = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/u;

export const repositoryName = (repository: Repository): string =>
  `${repository.host}/${repository.owner}/${repository.name}`;

const commandGap = (check: string | null, result: CommandResult, reason: string): CheckGap => ({
  check,
  command: result.command,
  code: result.code,
  stderr: result.stderr.trim(),
  reason,
});

const failedCommandReason = (result: CommandResult) =>
  result.killed ? `${result.command} was stopped.` : `${result.command} failed.`;

const parseCheckList = (
  stdout: string,
  validate: CheckListValidation,
): { checks: CheckItem[] } | { problem: string } => {
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

  const parsed = parseCheckList(result.stdout, validate);

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

export const isFailing = (check: CheckItem): boolean =>
  check.bucket === 'fail' || check.bucket === 'cancel';

const sameRepository = (repository: Repository, host: string, owner: string, name: string) =>
  repositoryName(repository).toLowerCase() === `${host}/${owner}/${name}`.toLowerCase();

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
  reason: `The link "${check.link}" is not a GitHub Actions job of ${repositoryName(repository)}, so its log was not read.`,
});

export const failedLogEvidence = (
  check: CheckItem,
  result: CommandResult,
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

  return { log: boundedExcerpt(result.stdout) };
};
