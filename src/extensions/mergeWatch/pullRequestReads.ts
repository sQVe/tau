import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { checkOutput, parseJson, runCommand } from '../../command.js';
import type { CommandRuntime } from '../../command.js';
import type { AutoMergeRequest } from './autoMergeRequest.js';
import type { WatchFacts } from './watchOutcome.js';

const resolvedSchema = Type.Object({ url: Type.String({ minLength: 1 }) });

const stateSchema = Type.Object({
  state: Type.String(),
  mergedAt: Type.Union([Type.String(), Type.Null()]),
});

const checksSchema = Type.Array(Type.Object({ name: Type.String(), bucket: Type.String() }));

// gh pr checks exits 1 while a check fails and 8 while one is pending, and still prints the list.
const failingChecksExitCode = 1;
const pendingChecksExitCode = 8;
const listedExitCodes = new Set([0, failingChecksExitCode, pendingChecksExitCode]);
const noChecksPattern = /no (?:required )?checks reported/u;

const readJson = async (runtime: CommandRuntime, commandArguments: string[]) => {
  const label = ['gh', ...commandArguments].join(' ');
  const stdout = await runCommand(runtime, 'gh', commandArguments, label);

  return { label, value: parseJson(label, stdout) };
};

// Returns the URL of the pull request a merge command named, or undefined when gh cannot read it.
export const resolvePullRequest = async (
  runtime: CommandRuntime,
  request: AutoMergeRequest,
): Promise<string | undefined> => {
  const commandArguments = ['pr', 'view'];

  if (request.selector !== undefined) {
    commandArguments.push(request.selector);
  }

  if (request.repository !== undefined) {
    commandArguments.push('--repo', request.repository);
  }

  try {
    const { label, value } = await readJson(runtime, [...commandArguments, '--json', 'url']);

    checkOutput(label, resolvedSchema, value);

    return value.url;
  } catch {
    return undefined;
  }
};

export const readPullRequestState = async (
  runtime: CommandRuntime,
  url: string,
): Promise<WatchFacts['pullRequest']> => {
  try {
    const { label, value } = await readJson(runtime, [
      'pr',
      'view',
      url,
      '--json',
      'state,mergedAt',
    ]);

    checkOutput(label, stateSchema, value);

    return value;
  } catch {
    return undefined;
  }
};

const parseChecks = (stdout: string): WatchFacts['checks'] => {
  try {
    const value: unknown = JSON.parse(stdout);

    return Value.Check(checksSchema, value) ? value : undefined;
  } catch {
    return undefined;
  }
};

// Returns an empty list when the pull request has no required checks.
export const readRequiredChecks = async (
  runtime: CommandRuntime,
  url: string,
): Promise<WatchFacts['checks']> => {
  try {
    const result = await runtime.exec(
      'gh',
      ['pr', 'checks', url, '--required', '--json', 'name,bucket,state'],
      { cwd: runtime.cwd, ...(runtime.signal === undefined ? {} : { signal: runtime.signal }) },
    );

    if (result.killed || !listedExitCodes.has(result.code)) {
      return undefined;
    }

    if (result.stdout.trim() === '' && noChecksPattern.test(result.stderr)) {
      return [];
    }

    return parseChecks(result.stdout);
  } catch {
    return undefined;
  }
};
