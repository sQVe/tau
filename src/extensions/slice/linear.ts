import { Type } from 'typebox';
import type { Static } from 'typebox';

import type { Exec, CommandRuntime } from '../../command.js';
import { checkOutput, readJson } from '../../github/github.js';
import { api, openStateTypes, readTeamId, run } from '../../linear.js';
import type { LinearChild, LinearContainer } from './writes.js';

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

const containerQuery =
  'query($id: String!) { issue(id: $id) { id identifier title description url state { type } attachments(first: 100) { pageInfo { hasNextPage } nodes { url } } team { id key } project { id name } children(first: 100) { pageInfo { hasNextPage } nodes { identifier title description url team { id } subIssueSortOrder state { type } attachments(first: 100) { pageInfo { hasNextPage } nodes { url } } inverseRelations(first: 100) { pageInfo { hasNextPage } nodes { type issue { identifier } } } } } } }';

const issuesQuery =
  'query($filter: IssueFilter!) { issues(first: 50, filter: $filter) { nodes { identifier } } }';

const teamProjectQuery =
  'query($key: String!, $name: String!) { team(id: $key) { id projects(filter: { name: { eq: $name } }) { nodes { id } } } }';

// `linear issue create --parent` copies the parent's project, so create through the API with the
// team, project, and parent set explicitly. Linear's schema documents
// preserveSortOrderOnCreate as the way to keep a passed sort order, and Linear rejects null for it.
const createMutation =
  'mutation($team: String!, $project: String, $parent: String, $title: String!, $description: String!, $subIssueSortOrder: Float, $preserveSortOrderOnCreate: Boolean, $labels: [String!]) { issueCreate(input: { teamId: $team, projectId: $project, parentId: $parent, title: $title, labelIds: $labels, description: $description, subIssueSortOrder: $subIssueSortOrder, preserveSortOrderOnCreate: $preserveSortOrderOnCreate }) { issue { id identifier url } } }';

const updateMutation =
  'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }';

const pageInfoSchema = Type.Object({ hasNextPage: Type.Boolean() });

const childSchema = Type.Object({
  identifier: Type.String(),
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  url: Type.String(),
  subIssueSortOrder: Type.Number(),
  team: Type.Object({ id: Type.String() }),
  state: Type.Object({ type: Type.String() }),
  attachments: Type.Object({
    pageInfo: pageInfoSchema,
    nodes: Type.Array(Type.Object({ url: Type.String() })),
  }),
  inverseRelations: Type.Object({
    pageInfo: pageInfoSchema,
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
      attachments: Type.Object({
        pageInfo: pageInfoSchema,
        nodes: Type.Array(Type.Object({ url: Type.String() })),
      }),
      team: Type.Object({ id: Type.String(), key: Type.String() }),
      project: Type.Union([Type.Object({ id: Type.String(), name: Type.String() }), Type.Null()]),
      children: Type.Object({ pageInfo: pageInfoSchema, nodes: Type.Array(childSchema) }),
    }),
    Type.Null(),
  ]),
});

const issuesSchema = Type.Object({
  issues: Type.Object({ nodes: Type.Array(Type.Object({ identifier: Type.String() })) }),
});

const teamProjectSchema = Type.Object({
  team: Type.Union([
    Type.Object({
      id: Type.String(),
      projects: Type.Object({ nodes: Type.Array(Type.Object({ id: Type.String() })) }),
    }),
    Type.Null(),
  ]),
});

const createSchema = Type.Object({
  issueCreate: Type.Object({
    issue: Type.Object({ id: Type.String(), identifier: Type.String(), url: Type.String() }),
  }),
});

const updateSchema = Type.Object({ issueUpdate: Type.Object({ success: Type.Literal(true) }) });
const pullRequestSchema = Type.Object({ state: Type.String() });

const pullRequestUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/u;

type ChildNode = Static<typeof childSchema>;

const readPullRequestState = async (exec: Exec, cwd: string, url: string) => {
  const runtime: CommandRuntime = { exec, cwd, signal: undefined };
  const commandArguments = ['pr', 'view', url, '--json', 'state'];
  const value = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, pullRequestSchema, value);

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
  canceled: node.state.type === 'canceled',
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
  const { issue } = await api(exec, cwd, containerQuery, { id: identifier }, containerSchema);

  if (issue === null) {
    return undefined;
  }

  const connections = [
    issue.attachments,
    issue.children,
    ...issue.children.nodes.flatMap((child) => [child.attachments, child.inverseRelations]),
  ];

  const hasAnotherPage = connections.some((connection) => connection.pageInfo.hasNextPage);

  // A list with more pages could hide the child or the attachment that a write depends on.
  if (hasAnotherPage) {
    throw new Error(
      `${identifier} has more than one Linear page of children, attachments, or relations, so a write could be planned from a partial list. Nothing was written.`,
    );
  }

  const nodes = issue.children.nodes
    .filter((child) => child.team.id === issue.team.id)
    .toSorted((left, right) => left.subIssueSortOrder - right.subIssueSortOrder);

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

// Lists the open issues in the route's team, and its project when the route names one, whose title
// is exactly the given title.
export const findOpenIssues = async (
  exec: Exec,
  cwd: string,
  search: { team: string; project: string | null; title: string },
): Promise<string[]> => {
  const filter: Record<string, unknown> = {
    team: { key: { eq: search.team } },
    title: { eq: search.title },
    state: { type: { in: openStateTypes } },
  };

  if (search.project !== null) {
    filter['project'] = { name: { eq: search.project } };
  }

  const data = await api(exec, cwd, issuesQuery, { filter }, issuesSchema);

  return data.issues.nodes.map((issue) => issue.identifier);
};

// Looks the project up among the team's projects, since another team may use the same name.
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

export const changeBlockedBy = async (
  exec: Exec,
  cwd: string,
  change: { action: 'add' | 'delete'; identifier: string; blocker: string },
): Promise<void> => {
  const commandArguments = [
    'issue',
    'relation',
    change.action,
    change.identifier,
    'blocked-by',
    change.blocker,
  ];

  // Without --yes, `relation delete` asks for confirmation and fails without a terminal.
  if (change.action === 'delete') {
    commandArguments.push('--yes');
  }

  await run(exec, cwd, commandArguments);
};

export const moveIssue = async (
  exec: Exec,
  cwd: string,
  identifier: string,
  sortOrder: number,
): Promise<void> => {
  await update(exec, cwd, identifier, { subIssueSortOrder: sortOrder });
};
