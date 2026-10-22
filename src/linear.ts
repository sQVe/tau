import { Type } from 'typebox';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { outputPreviewLength, parseJson, runCommand } from './command.js';
import type { Exec } from './command.js';
import { errorMessage } from './errors.js';

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

export const api = async <Schema extends TSchema>(
  exec: Exec,
  cwd: string,
  query: string,
  variables: Record<string, unknown>,
  schema: Schema,
): Promise<Static<Schema>> => {
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

  if (!Value.Check(schema, data)) {
    throw new Error(`${label} printed unexpected output: ${stdout.slice(0, outputPreviewLength)}`);
  }

  // oxlint-disable-next-line typescript/no-unsafe-return -- the generic schema type cannot narrow the checked value.
  return data;
};

const teamQuery = 'query($key: String!) { team(id: $key) { id } }';

const teamSchema = Type.Object({
  team: Type.Union([Type.Object({ id: Type.String() }), Type.Null()]),
});

// Throws when Linear has no team with that key.
export const readTeamId = async (exec: Exec, cwd: string, key: string): Promise<string> => {
  const { team } = await api(exec, cwd, teamQuery, { key }, teamSchema);

  if (team === null) {
    throw new Error(`Linear has no team ${key}.`);
  }

  return team.id;
};
