import type { Exec } from './exec.js';

export interface ApiResponse {
  label: string;
  stdout: string;
  data: unknown;
}

const outputPreviewLength = 200;

// Linear also has closed state types besides `completed` and `canceled`, such as `duplicate`, so open
// issues are matched by an allow-list.
export const openStateTypes = ['triage', 'backlog', 'unstarted', 'started'];

const errorMessage = (error: unknown) => {
  const message: unknown =
    typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined;

  return typeof message === 'string' ? message : JSON.stringify(error);
};

// GraphQL can return partial `data` beside `errors`, with a failed field set to null.
const graphqlErrors = (value: unknown): string[] => {
  const errors: unknown =
    typeof value === 'object' && value !== null && 'errors' in value ? value.errors : undefined;

  return Array.isArray(errors) ? errors.map(errorMessage) : [];
};

const describe = (command: string, commandArguments: readonly string[]) =>
  [command, ...commandArguments.slice(0, 2)].join(' ');

export const run = async (
  exec: Exec,
  cwd: string,
  command: string,
  commandArguments: string[],
): Promise<string> => {
  const result = await exec(command, commandArguments, { cwd });

  if (result.code !== 0 || result.killed) {
    const output = (result.stderr || result.stdout).trim();

    throw new Error(`${describe(command, commandArguments)} failed: ${output}`);
  }

  return result.stdout;
};

export const unexpectedOutput = ({ label, stdout }: ApiResponse): Error =>
  new Error(`${label} printed unexpected output: ${stdout.slice(0, outputPreviewLength)}`);

export const api = async (
  exec: Exec,
  cwd: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<ApiResponse> => {
  const label = `linear api ${query.slice(0, query.indexOf('('))}`;

  // `--variable` turns values such as `123`, `true`, and `null` into other JSON types, so every
  // value goes through `--variables-json`.
  const stdout = await run(exec, cwd, 'linear', [
    'api',
    query,
    '--variables-json',
    JSON.stringify(variables),
  ]);

  let value: unknown;

  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${label} printed output that is not JSON: ${stdout.slice(0, outputPreviewLength)}`,
      { cause: error },
    );
  }

  const errors = graphqlErrors(value);

  if (errors.length > 0) {
    throw new Error(`${label} returned GraphQL errors: ${errors.join('; ')}`);
  }

  const data: unknown =
    typeof value === 'object' && value !== null && 'data' in value ? value.data : undefined;

  return { label, stdout, data };
};
