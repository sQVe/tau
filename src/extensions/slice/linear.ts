import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import type { LinearChild, LinearContainer } from './writes.js';

export interface CreatedIssue {
  id: string;
  identifier: string;
  url: string;
}

export type Exec = Pick<ExtensionAPI, 'exec'>['exec'];

interface ApiResponse {
  label: string;
  stdout: string;
  data: unknown;
}

interface IssueInput {
  title?: string;
  description?: string;
  subIssueSortOrder?: number;
}

const containerQuery =
  'query($id: String!) { issue(id: $id) { id identifier title description url state { type } attachments { nodes { url } } team { id key } project { id name } children { nodes { identifier title description url subIssueSortOrder state { type } attachments { nodes { url } } inverseRelations { nodes { type issue { identifier } } } } } } }';

const teamQuery = 'query($key: String!) { team(id: $key) { id } }';

const projectQuery =
  'query($name: String!) { projects(filter: { name: { eq: $name } }) { nodes { id } } }';

// `linear issue create --parent` copies the parent's project, so create through the API with the
// team, project, and parent set explicitly.
const createMutation =
  'mutation($team: String!, $project: String, $parent: String, $title: String!, $description: String!) { issueCreate(input: { teamId: $team, projectId: $project, parentId: $parent, title: $title, description: $description }) { issue { id identifier url } } }';

const updateMutation =
  'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }';

const childSchema = Type.Object({
  identifier: Type.String(),
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  url: Type.String(),
  subIssueSortOrder: Type.Number(),
  state: Type.Object({ type: Type.String() }),
  attachments: Type.Object({ nodes: Type.Array(Type.Object({ url: Type.String() })) }),
  inverseRelations: Type.Object({
    nodes: Type.Array(
      Type.Object({ type: Type.String(), issue: Type.Object({ identifier: Type.String() }) }),
    ),
  }),
});

const containerSchema = Type.Object({
  issue: Type.Union([
    Type.Object({
      id: Type.String(),
      identifier: Type.String(),
      title: Type.String(),
      description: Type.Union([Type.String(), Type.Null()]),
      url: Type.String(),
      state: Type.Object({ type: Type.String() }),
      attachments: Type.Object({ nodes: Type.Array(Type.Object({ url: Type.String() })) }),
      team: Type.Object({ id: Type.String(), key: Type.String() }),
      project: Type.Union([Type.Object({ id: Type.String(), name: Type.String() }), Type.Null()]),
      children: Type.Object({ nodes: Type.Array(childSchema) }),
    }),
    Type.Null(),
  ]),
});

const teamSchema = Type.Object({
  team: Type.Union([Type.Object({ id: Type.String() }), Type.Null()]),
});

const projectSchema = Type.Object({
  projects: Type.Object({ nodes: Type.Array(Type.Object({ id: Type.String() })) }),
});

const createSchema = Type.Object({
  issueCreate: Type.Object({
    issue: Type.Object({ id: Type.String(), identifier: Type.String(), url: Type.String() }),
  }),
});

const updateSchema = Type.Object({ issueUpdate: Type.Object({ success: Type.Literal(true) }) });
const pullRequestSchema = Type.Object({ state: Type.String() });

const outputPreviewLength = 200;

const pullRequestUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/u;

type ChildNode = Static<typeof childSchema>;

const describe = (command: string, commandArguments: readonly string[]) =>
  [command, ...commandArguments.slice(0, 2)].join(' ');

const run = async (
  exec: Exec,
  cwd: string,
  command: string,
  commandArguments: string[],
): Promise<string> => {
  const result = await exec(command, commandArguments, { cwd });

  if (result.code !== 0) {
    const output = (result.stderr || result.stdout).trim();

    throw new Error(`${describe(command, commandArguments)} failed: ${output}`);
  }

  return result.stdout;
};

const unexpectedOutput = ({ label, stdout }: ApiResponse) =>
  new Error(`${label} printed unexpected output: ${stdout.slice(0, outputPreviewLength)}`);

const api = async (
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

  const data: unknown =
    typeof value === 'object' && value !== null && 'data' in value ? value.data : undefined;

  return { label, stdout, data };
};

const readPullRequestState = async (exec: Exec, cwd: string, url: string) => {
  const stdout = await run(exec, cwd, 'gh', ['pr', 'view', url, '--json', 'state']);
  let value: unknown;

  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`gh pr view ${url} printed output that is not JSON: ${stdout}`, {
      cause: error,
    });
  }

  if (!Value.Check(pullRequestSchema, value)) {
    throw new Error(`gh pr view ${url} printed unexpected output: ${stdout}`);
  }

  return value.state;
};

const readMerged = async (exec: Exec, cwd: string, urls: readonly string[]) => {
  const pullRequests = urls.filter((candidate) => pullRequestUrl.test(candidate));
  const states = await Promise.all(pullRequests.map((url) => readPullRequestState(exec, cwd, url)));

  return states.includes('MERGED');
};

const toChild = async (exec: Exec, cwd: string, node: ChildNode): Promise<LinearChild> => ({
  identifier: node.identifier,
  title: node.title,
  description: node.description ?? '',
  url: node.url,
  sortOrder: node.subIssueSortOrder,
  completed: node.state.type === 'completed',
  merged: await readMerged(
    exec,
    cwd,
    node.attachments.nodes.map((attachment) => attachment.url),
  ),
  // Linear saves "A blocked by B" as a `blocks` relation on B.
  blockedBy: node.inverseRelations.nodes
    .filter((relation) => relation.type === 'blocks')
    .map((relation) => relation.issue.identifier),
});

// Reads the container and its children, sorted by sub-issue order. Undefined when Linear has no
// issue with that identifier.
export const readContainer = async (
  exec: Exec,
  cwd: string,
  identifier: string,
): Promise<LinearContainer | undefined> => {
  const response = await api(exec, cwd, containerQuery, { id: identifier });

  if (!Value.Check(containerSchema, response.data)) {
    throw unexpectedOutput(response);
  }

  const { issue } = response.data;

  if (issue === null) {
    return undefined;
  }

  const nodes = issue.children.nodes.toSorted(
    (left, right) => left.subIssueSortOrder - right.subIssueSortOrder,
  );

  const children = await Promise.all(nodes.map((node) => toChild(exec, cwd, node)));
  const attachmentUrls = issue.attachments.nodes.map((attachment) => attachment.url);

  return {
    id: issue.id,
    identifier: issue.identifier,
    completed: issue.state.type === 'completed',
    merged: await readMerged(exec, cwd, attachmentUrls),
    title: issue.title,
    description: issue.description ?? '',
    url: issue.url,
    team: issue.team,
    project: issue.project,
    children,
  };
};

export const readRouteIds = async (
  exec: Exec,
  cwd: string,
  route: { team: string; project: string | null },
): Promise<{ team: string; project: string | null }> => {
  const teamResponse = await api(exec, cwd, teamQuery, { key: route.team });

  if (!Value.Check(teamSchema, teamResponse.data)) {
    throw unexpectedOutput(teamResponse);
  }

  const { team } = teamResponse.data;

  if (team === null) {
    throw new Error(`Linear has no team ${route.team}.`);
  }

  if (route.project === null) {
    return { team: team.id, project: null };
  }

  const projectResponse = await api(exec, cwd, projectQuery, { name: route.project });

  if (!Value.Check(projectSchema, projectResponse.data)) {
    throw unexpectedOutput(projectResponse);
  }

  const { projects } = projectResponse.data;
  const [project, ...others] = projects.nodes;

  if (project === undefined || others.length > 0) {
    throw new Error(`Linear does not have exactly one project named ${route.project}.`);
  }

  return { team: team.id, project: project.id };
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
  },
): Promise<CreatedIssue> => {
  const response = await api(exec, cwd, createMutation, issue);

  if (!Value.Check(createSchema, response.data)) {
    throw unexpectedOutput(response);
  }

  return response.data.issueCreate.issue;
};

const update = async (exec: Exec, cwd: string, identifier: string, input: IssueInput) => {
  const response = await api(exec, cwd, updateMutation, { id: identifier, input });

  if (!Value.Check(updateSchema, response.data)) {
    throw unexpectedOutput(response);
  }
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

export const changeBlockedBy = async (
  exec: Exec,
  cwd: string,
  change: { action: 'add' | 'delete'; identifier: string; blocker: string },
): Promise<void> => {
  await run(exec, cwd, 'linear', [
    'issue',
    'relation',
    change.action,
    change.identifier,
    'blocked-by',
    change.blocker,
  ]);
};

export const moveIssue = async (
  exec: Exec,
  cwd: string,
  identifier: string,
  sortOrder: number,
): Promise<void> => {
  await update(exec, cwd, identifier, { subIssueSortOrder: sortOrder });
};
