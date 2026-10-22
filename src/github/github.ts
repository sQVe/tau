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
