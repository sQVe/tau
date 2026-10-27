import type { Static, TSchema } from 'typebox';

import {
  checkOutput as checkCommandOutput,
  parseJson as parseCommandJson,
  runCommand,
} from '../command.js';
import type { CommandRuntime } from '../command.js';

export interface Repository {
  host: string;
  owner: string;
  name: string;
}

// TypeScript accepts an assertion arrow function only through a declared type.
export type CheckOutput = <Schema extends TSchema>(
  commandArguments: readonly string[],
  schema: Schema,
  value: unknown,
) => asserts value is Static<Schema>;

export interface GhOutcome {
  exitCode: number;
  cancelled: boolean;
  stdout: string;
  stderr: string;
}

export interface PullRequestListQuery {
  repository: string;
  // Flags that select the pull requests, such as ['--head', branch].
  filter: readonly string[];
  state: string;
  fields: string;
}

const repositoryPart = /^[\w.-]+$/u;
const hostPattern = /^[\w.-]+(?::\d+)?$/u;

export const parseRepository = (repository: string): Repository => {
  const [host = '', owner = '', name = '', ...rest] = repository.split('/');
  const namesValid = repositoryPart.test(owner) && repositoryPart.test(name);

  if (rest.length > 0 || !hostPattern.test(host) || !namesValid) {
    throw new Error(
      `repository must be <host>/<owner>/<name>, such as github.com/sQVe/tau, not ${repository}.`,
    );
  }

  return { host, owner, name };
};

const isLongValue = (argument: string) =>
  argument.startsWith('query=') || argument.startsWith('body=');

export const label = (commandArguments: readonly string[]): string =>
  ['gh', ...commandArguments.filter((argument) => !isLongValue(argument))].join(' ');

export const run = (runtime: CommandRuntime, commandArguments: string[]): Promise<string> => {
  const commandLabel = label(commandArguments);

  return runCommand(runtime, 'gh', commandArguments, commandLabel);
};

// Unlike run, never throws on a nonzero exit, so the caller decides what each exit code means.
export const runOutcome = async (
  runtime: CommandRuntime,
  commandArguments: string[],
): Promise<GhOutcome> => {
  const result = await runtime.exec('gh', commandArguments, {
    cwd: runtime.cwd,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });

  return {
    exitCode: result.code,
    cancelled: result.killed,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

export const parseJson = (commandArguments: readonly string[], stdout: string): unknown =>
  parseCommandJson(label(commandArguments), stdout);

export const readJson = async (
  runtime: CommandRuntime,
  commandArguments: string[],
): Promise<unknown> => parseJson(commandArguments, await run(runtime, commandArguments));

// Names the command and the first field that does not match.
export const checkOutput: CheckOutput = (commandArguments, schema, value) => {
  checkCommandOutput(label(commandArguments), schema, value);
};

export const readChecked = async <Schema extends TSchema>(
  runtime: CommandRuntime,
  commandArguments: string[],
  schema: Schema,
): Promise<Static<Schema>> => {
  const value = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, schema, value);

  // oxlint-disable-next-line typescript/no-unsafe-return -- the generic schema type cannot narrow the checked value.
  return value;
};

// gh pr list prints at most --limit pull requests and does not say when it left some out.
const listLimit = 100;

export const pullRequestListArguments = (query: PullRequestListQuery): string[] => [
  'pr',
  'list',
  '--repo',
  query.repository,
  ...query.filter,
  '--state',
  query.state,
  '--limit',
  String(listLimit),
  '--json',
  query.fields,
];

// Returns the problem with a list that reached the limit, or undefined when it is complete.
export const incompleteListProblem = (listed: readonly unknown[]): string | undefined =>
  listed.length >= listLimit
    ? `printed ${listed.length} pull requests, the limit, so the list may be incomplete.`
    : undefined;
