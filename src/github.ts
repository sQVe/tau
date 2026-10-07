import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type { Exec } from './exec.js';
import { describeSchemaProblem } from './schemaProblem.js';

export interface Repository {
  host: string;
  owner: string;
  name: string;
}

export interface Runtime {
  exec: Exec;
  cwd: string;
  signal: AbortSignal | undefined;
}

// TypeScript accepts an assertion arrow function only through a declared type.
export type CheckOutput = <Schema extends TSchema>(
  commandArguments: readonly string[],
  schema: Schema,
  value: unknown,
) => asserts value is Static<Schema>;

const outputPreviewLength = 200;

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

const preview = (stdout: string) => stdout.slice(0, outputPreviewLength);

export const run = async (runtime: Runtime, commandArguments: string[]): Promise<string> => {
  const result = await runtime.exec('gh', commandArguments, {
    cwd: runtime.cwd,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });

  if (result.code !== 0 || result.killed) {
    const output = (result.stderr || result.stdout).trim();

    throw new Error(`${label(commandArguments)} failed: ${output}`);
  }

  return result.stdout;
};

export const parseJson = (commandArguments: readonly string[], stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${label(commandArguments)} printed output that is not JSON: ${preview(stdout)}`,
      { cause: error },
    );
  }
};

export const readJson = async (runtime: Runtime, commandArguments: string[]): Promise<unknown> =>
  parseJson(commandArguments, await run(runtime, commandArguments));

// Names the command and the first field that does not match.
export const checkOutput: CheckOutput = (commandArguments, schema, value) => {
  if (!Value.Check(schema, value)) {
    throw new Error(
      `${label(commandArguments)} printed unexpected output: ${describeSchemaProblem(schema, value)}`,
    );
  }
};
