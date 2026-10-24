import { Type } from 'typebox';

import type { Exec } from '../../command.js';
import { api, openStateTypes, readTeamId } from '../../linear.js';

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
