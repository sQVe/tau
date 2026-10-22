import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { describeSchemaProblem } from './schemaProblem.js';

export type Exec = ExtensionAPI['exec'];

// TypeScript accepts an assertion arrow function only through a declared type.
export type CheckOutput = <Schema extends TSchema>(
  label: string,
  schema: Schema,
  value: unknown,
) => asserts value is Static<Schema>;

export interface CommandRuntime {
  exec: Exec;
  cwd: string;
  signal?: AbortSignal | undefined;
}

export const outputPreviewLength = 200;

export const runCommand = async (
  runtime: CommandRuntime,
  command: string,
  commandArguments: string[],
  label: string,
): Promise<string> => {
  const result = await runtime.exec(command, commandArguments, {
    cwd: runtime.cwd,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });

  if (result.code !== 0 || result.killed) {
    const output = (result.stderr || result.stdout).trim();

    throw new Error(`${label} failed: ${output}`);
  }

  return result.stdout;
};

export const parseJson = (label: string, stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${label} printed output that is not JSON: ${stdout.slice(0, outputPreviewLength)}`,
      { cause: error },
    );
  }
};

export const checkOutput: CheckOutput = (label, schema, value) => {
  if (!Value.Check(schema, value)) {
    throw new Error(`${label} printed unexpected output: ${describeSchemaProblem(schema, value)}`);
  }
};
