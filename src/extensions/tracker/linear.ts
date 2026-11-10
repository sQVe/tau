import { Type } from 'typebox';
import type { Static } from 'typebox';

import type { Exec } from '../../command.js';
import { api, openStateTypes, readTeamId } from '../../linear/linear.js';
import type { TicketOwners } from '../../linear/ownership.js';
import type { TicketComment } from './commentTarget.js';

interface TicketComments extends TicketOwners {
  id: string;
  identifier: string;
  viewer: string;
  comments: TicketComment[];
}

interface SavedComment {
  id: string;
  url: string;
}

export interface FoundIssue {
  identifier: string;
  title: string;
  url: string;
  team: string;
  project: string | null;
  parent: string | null;
}

export interface ParentRouting {
  team: string;
  project: string | null;
  state: string;
}

export interface Label {
  id: string;
  name: string;
}

export interface LabelList {
  labels: Label[];
  hasNextPage: boolean;
}

export interface IssueList {
  issues: FoundIssue[];
  hasNextPage: boolean;
}

const searchPageSize = 50;
const labelPageSize = 250;

const searchQuery =
  'query($term: String!, $first: Int!, $teamId: String!, $filter: IssueFilter!) { searchIssues(term: $term, first: $first, teamId: $teamId, filter: $filter) { nodes { identifier title url state { type } team { key } project { name } parent { identifier } } pageInfo { hasNextPage } } }';

const parentQuery =
  'query($id: String!) { issue(id: $id) { team { key } project { name } state { name } } }';

const labelsQuery =
  'query($key: String!, $first: Int!) { team(id: $key) { labels(first: $first) { nodes { id name } pageInfo { hasNextPage } } } }';

const nameSchema = Type.Union([Type.Object({ name: Type.String() }), Type.Null()]);
const pageInfoSchema = Type.Object({ hasNextPage: Type.Boolean() });
const userSchema = Type.Union([Type.Object({ id: Type.String() }), Type.Null()]);

const commentSchema = Type.Object({
  id: Type.String(),
  url: Type.String(),
  body: Type.String(),
  user: userSchema,
});

const commentsQuery =
  'query($id: String!) { viewer { id } issue(id: $id) { id identifier assignee { id } creator { id } comments(first: 250) { nodes { id url body user { id } } pageInfo { hasNextPage } } } }';

const commentsSchema = Type.Object({
  viewer: Type.Object({ id: Type.String() }),
  issue: Type.Union([
    Type.Null(),
    Type.Object({
      id: Type.String(),
      identifier: Type.String(),
      assignee: userSchema,
      creator: userSchema,
      comments: Type.Object({ nodes: Type.Array(commentSchema), pageInfo: pageInfoSchema }),
    }),
  ]),
});

const commentUpdateMutation =
  'mutation($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { success comment { id url } } }';

const commentCreateMutation =
  'mutation($issue: String!, $body: String!) { commentCreate(input: { issueId: $issue, body: $body }) { success comment { id url } } }';

const commentResultSchema = Type.Object({
  success: Type.Literal(true),
  comment: Type.Object({ id: Type.String({ minLength: 1 }), url: Type.String() }),
});

const searchSchema = Type.Object({
  searchIssues: Type.Object({
    nodes: Type.Array(
      Type.Object({
        identifier: Type.String(),
        title: Type.String(),
        url: Type.String(),
        state: Type.Object({ type: Type.String() }),
        team: Type.Object({ key: Type.String() }),
        project: nameSchema,
        parent: Type.Union([Type.Object({ identifier: Type.String() }), Type.Null()]),
      }),
    ),
    pageInfo: pageInfoSchema,
  }),
});

const parentSchema = Type.Object({
  issue: Type.Union([
    Type.Object({
      team: Type.Object({ key: Type.String() }),
      project: nameSchema,
      state: Type.Object({ name: Type.String() }),
    }),
    Type.Null(),
  ]),
});

const labelsSchema = Type.Object({
  team: Type.Union([
    Type.Object({
      labels: Type.Object({
        nodes: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })),
        pageInfo: pageInfoSchema,
      }),
    }),
    Type.Null(),
  ]),
});

export const readComments = async (
  exec: Exec,
  cwd: string,
  identifier: string,
): Promise<TicketComments> => {
  const { viewer, issue } = await api(exec, cwd, commentsQuery, { id: identifier }, commentsSchema);

  if (issue === null) {
    throw new Error(`Linear has no issue ${identifier}.`);
  }

  if (issue.comments.pageInfo.hasNextPage) {
    throw new Error(`The comments for ${identifier} have another page. Nothing was written.`);
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    viewer: viewer.id,
    assignee: issue.assignee?.id ?? null,
    creator: issue.creator?.id ?? null,
    comments: issue.comments.nodes,
  };
};

export const addComment = async (
  exec: Exec,
  cwd: string,
  input: { issue: string; body: string },
): Promise<SavedComment> => {
  const schema = Type.Object({ commentCreate: commentResultSchema });
  const result = await api(exec, cwd, commentCreateMutation, input, schema);

  return result.commentCreate.comment;
};

export const updateComment = async (
  exec: Exec,
  cwd: string,
  input: { id: string; body: string },
): Promise<SavedComment> => {
  const schema = Type.Object({ commentUpdate: commentResultSchema });
  const result = await api(exec, cwd, commentUpdateMutation, input, schema);

  return result.commentUpdate.comment;
};

const cancelQuery =
  'query($id: String!) { issue(id: $id) { identifier title state { type name } attachments(first: 100) { nodes { url } pageInfo { hasNextPage } } } }';

const cancelSchema = Type.Object({
  issue: Type.Union([
    Type.Null(),
    Type.Object({
      identifier: Type.String(),
      title: Type.String(),
      state: Type.Object({ type: Type.String(), name: Type.String() }),
      attachments: Type.Object({
        nodes: Type.Array(Type.Object({ url: Type.String() })),
        pageInfo: pageInfoSchema,
      }),
    }),
  ]),
});

export const readCancellation = async (
  exec: Exec,
  cwd: string,
  identifier: string,
): Promise<NonNullable<Static<typeof cancelSchema>['issue']>> => {
  const { issue } = await api(exec, cwd, cancelQuery, { id: identifier }, cancelSchema);

  if (issue === null) {
    throw new Error(`Linear has no issue ${identifier}.`);
  }

  if (issue.attachments.pageInfo.hasNextPage) {
    throw new Error(`The attachments for ${identifier} have another page. Nothing was written.`);
  }

  return issue;
};

// Searches the open issues in the route's team, and its project when the route names one. The team
// goes in teamId, not in the filter: with a team filter, Linear leaves out real matches.
export const searchIssues = async (
  exec: Exec,
  cwd: string,
  search: { team: string; project: string | null; keywords: string },
): Promise<IssueList> => {
  const teamId = await readTeamId(exec, cwd, search.team);
  const filter: Record<string, unknown> = { state: { type: { in: openStateTypes } } };

  if (search.project !== null) {
    filter['project'] = { name: { eq: search.project } };
  }

  const data = await api(
    exec,
    cwd,
    searchQuery,
    { term: search.keywords, first: searchPageSize, teamId, filter },
    searchSchema,
  );

  const issues = data.searchIssues.nodes.map((node) => ({
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    team: node.team.key,
    project: node.project?.name ?? null,
    parent: node.parent?.identifier ?? null,
  }));

  return { issues, hasNextPage: data.searchIssues.pageInfo.hasNextPage };
};

// Throws when Linear has no issue with that identifier.
export const readParentRouting = async (
  exec: Exec,
  cwd: string,
  identifier: string,
): Promise<ParentRouting> => {
  const { issue } = await api(exec, cwd, parentQuery, { id: identifier }, parentSchema);

  if (issue === null) {
    throw new Error(`Linear has no issue ${identifier}.`);
  }

  return { team: issue.team.key, project: issue.project?.name ?? null, state: issue.state.name };
};

// Throws when Linear has no team with that key.
export const readLabels = async (exec: Exec, cwd: string, team: string): Promise<LabelList> => {
  const data = await api(exec, cwd, labelsQuery, { key: team, first: labelPageSize }, labelsSchema);
  const found = data.team;

  if (found === null) {
    throw new Error(`Linear has no team ${team}.`);
  }

  return { labels: found.labels.nodes, hasNextPage: found.labels.pageInfo.hasNextPage };
};
