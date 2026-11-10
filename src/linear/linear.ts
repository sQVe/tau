import { Type } from 'typebox';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { outputPreviewLength, parseJson, runCommand } from '../command.js';
import type { Exec } from '../command.js';
import { errorMessage } from '../errors.js';

export interface CreatedIssue {
  id: string;
  identifier: string;
  url: string;
}

interface IssueInput {
  title?: string;
  description?: string;
  subIssueSortOrder?: number;
}

// `linear issue create --parent` copies the parent's project, so create through the API with the
// team, project, and parent set explicitly. Linear's schema documents
// preserveSortOrderOnCreate as the way to keep a passed sort order, and Linear rejects null for it.
const createMutation =
  'mutation($team: String!, $project: String, $parent: String, $title: String!, $description: String!, $subIssueSortOrder: Float, $preserveSortOrderOnCreate: Boolean, $labels: [String!]) { issueCreate(input: { teamId: $team, projectId: $project, parentId: $parent, title: $title, labelIds: $labels, description: $description, subIssueSortOrder: $subIssueSortOrder, preserveSortOrderOnCreate: $preserveSortOrderOnCreate }) { issue { id identifier url } } }';

const updateMutation =
  'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }';

const createSchema = Type.Object({
  issueCreate: Type.Object({
    issue: Type.Object({ id: Type.String(), identifier: Type.String(), url: Type.String() }),
  }),
});

const updateSchema = Type.Object({ issueUpdate: Type.Object({ success: Type.Literal(true) }) });

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

export const createIssue = async (
  exec: Exec,
  cwd: string,
  issue: {
    team: string;
    project: string | null;
    parent: string | null;
    title: string;
    description: string;
    subIssueSortOrder: number | undefined;
    labels: readonly string[];
  },
): Promise<CreatedIssue> => {
  const preserveSortOrderOnCreate = issue.subIssueSortOrder !== undefined;

  const data = await api(
    exec,
    cwd,
    createMutation,
    { ...issue, preserveSortOrderOnCreate },
    createSchema,
  );

  return data.issueCreate.issue;
};

const update = async (exec: Exec, cwd: string, identifier: string, input: IssueInput) => {
  await api(exec, cwd, updateMutation, { id: identifier, input }, updateSchema);
};

export const updateIssue = async (
  exec: Exec,
  cwd: string,
  identifier: string,
  change: { title: string | undefined; description: string | undefined },
): Promise<void> => {
  const input: IssueInput = {};

  if (change.title !== undefined) {
    input.title = change.title;
  }

  if (change.description !== undefined) {
    input.description = change.description;
  }

  await update(exec, cwd, identifier, input);
};

export const moveIssue = async (
  exec: Exec,
  cwd: string,
  identifier: string,
  sortOrder: number,
): Promise<void> => {
  await update(exec, cwd, identifier, { subIssueSortOrder: sortOrder });
};

const teamProjectQuery =
  'query($key: String!, $name: String!) { team(id: $key) { id projects(filter: { name: { eq: $name } }) { nodes { id } } } }';

const teamProjectSchema = Type.Object({
  team: Type.Union([
    Type.Object({
      id: Type.String(),
      projects: Type.Object({ nodes: Type.Array(Type.Object({ id: Type.String() })) }),
    }),
    Type.Null(),
  ]),
});

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

const readTeamProjectIds = async (
  exec: Exec,
  cwd: string,
  route: { team: string; project: string },
) => {
  const { team } = await api(
    exec,
    cwd,
    teamProjectQuery,
    { key: route.team, name: route.project },
    teamProjectSchema,
  );

  if (team === null) {
    throw new Error(`Linear has no team ${route.team}.`);
  }

  const [project, ...others] = team.projects.nodes;

  if (project === undefined || others.length > 0) {
    throw new Error(
      `Linear team ${route.team} does not have exactly one project named ${route.project}.`,
    );
  }

  return { team: team.id, project: project.id };
};

export const readRouteIds = async (
  exec: Exec,
  cwd: string,
  route: { team: string; project: string | null },
): Promise<{ team: string; project: string | null }> => {
  if (route.project === null) {
    return { team: await readTeamId(exec, cwd, route.team), project: null };
  }

  return readTeamProjectIds(exec, cwd, { team: route.team, project: route.project });
};
