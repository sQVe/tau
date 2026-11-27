import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { describeSchemaProblem, isRecord } from './schema.js';

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

export const piExec =
  (pi: ExtensionAPI): Exec =>
  (command, commandArguments, options) =>
    pi.exec(command, commandArguments, options);

export const outputPreviewLength = 200;

// The abort signal's reason may be a plain value, which would reject with a non-Error.
export const normalizeCancellation = (
  signal: AbortSignal | undefined,
  error: unknown,
  message = 'Cancelled.',
): unknown =>
  signal?.aborted === true && !(error instanceof Error)
    ? new Error(message, { cause: error })
    : error;

export const commandFailure = (
  label: string,
  result: Awaited<ReturnType<Exec>>,
): Error | undefined => {
  if (result.code === 0 && !result.killed) {
    return undefined;
  }

  const output = (result.stderr.trim() || result.stdout.trim()).slice(0, outputPreviewLength);

  if (output !== '') {
    return new Error(`${label} failed: ${output}`);
  }

  const status = result.killed ? 'killed' : `exit code ${result.code}`;

  return new Error(`${label} failed: ${status}`);
};

export const runCommand = async (
  runtime: CommandRuntime,
  command: string,
  commandArguments: string[],
  label: string,
  options: { timeout?: number | undefined } = {},
): Promise<string> => {
  let result: Awaited<ReturnType<Exec>>;

  try {
    result = await runtime.exec(command, commandArguments, {
      cwd: runtime.cwd,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    });
  } catch (error) {
    throw normalizeCancellation(runtime.signal, error);
  }

  const failure = commandFailure(label, result);

  if (failure !== undefined) {
    throw failure;
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

// Returns the object a JSON document holds, or undefined when the text is not a JSON object.
export const parseJsonObject = (value: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(value);

    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const checkOutput: CheckOutput = (label, schema, value) => {
  if (!Value.Check(schema, value)) {
    throw new Error(`${label} printed unexpected output: ${describeSchemaProblem(schema, value)}`);
  }
};
