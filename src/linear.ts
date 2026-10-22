import { outputPreviewLength, parseJson, runCommand } from './command.js';
import type { Exec } from './command.js';
import { errorMessage } from './errors.js';

export interface ApiResponse {
  label: string;
  stdout: string;
  data: unknown;
}

// Linear also has closed state types besides `completed` and `canceled`, such as `duplicate`, so open
// issues are matched by an allow-list.
export const openStateTypes = ['triage', 'backlog', 'unstarted', 'started'];

// GraphQL can return partial `data` beside `errors`, with a failed field set to null.
const graphqlErrors = (value: unknown): string[] => {
  const errors: unknown =
    typeof value === 'object' && value !== null && 'errors' in value ? value.errors : undefined;

  return Array.isArray(errors) ? errors.map(errorMessage) : [];
};

const describe = (command: string, commandArguments: readonly string[]) =>
  [command, ...commandArguments.slice(0, 2)].join(' ');

export const run = (exec: Exec, cwd: string, commandArguments: string[]): Promise<string> => {
  const label = describe('linear', commandArguments);

  return runCommand({ exec, cwd }, 'linear', commandArguments, label);
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
  const stdout = await run(exec, cwd, [
    'api',
    query,
    '--variables-json',
    JSON.stringify(variables),
  ]);

  const value = parseJson(label, stdout);

  const errors = graphqlErrors(value);

  if (errors.length > 0) {
    throw new Error(`${label} returned GraphQL errors: ${errors.join('; ')}`);
  }

  const data: unknown =
    typeof value === 'object' && value !== null && 'data' in value ? value.data : undefined;

  return { label, stdout, data };
};
