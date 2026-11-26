import { Type } from 'typebox';
import type { Static } from 'typebox';

import type { Exec } from '../../command.js';
import { isPullRequestUrl, readPullRequestState } from '../../github/github.js';
import { api, run } from '../../linear/linear.js';
import { hasMergedPullRequest } from './startPickDecisions.js';
import type { PickPullRequest } from './startPickDecisions.js';
import type { LinearChild, LinearContainer } from './writes.js';

interface PickEvidence {
  branchName: string;
  canceled: boolean;
  blockedBy: string[];
  pullRequests: PickPullRequest[];
}

type ReadContainer = Omit<LinearContainer, 'children'> &
  PickEvidence & {
    children: (LinearChild & PickEvidence)[];
  };

const containerQuery =
  'query($id: String!) { viewer { id } issue(id: $id) { id identifier title description url branchName inverseRelations(first: 100) { pageInfo { hasNextPage } nodes { type issue { identifier } } } assignee { id } creator { id } state { type } attachments(first: 100) { pageInfo { hasNextPage } nodes { url metadata } } team { id key } project { id name } children(first: 100) { pageInfo { hasNextPage } nodes { identifier title description url branchName team { id } subIssueSortOrder assignee { id } creator { id } state { type } attachments(first: 100) { pageInfo { hasNextPage } nodes { url metadata } } inverseRelations(first: 100) { pageInfo { hasNextPage } nodes { type issue { identifier } } } } } } }';

const issuePullRequestsQuery =
  'query($id: String!) { issue(id: $id) { attachments(first: 100) { pageInfo { hasNextPage } nodes { url metadata } } } }';

const pageInfoSchema = Type.Object({ hasNextPage: Type.Boolean() });

const attachmentSchema = Type.Object({
  url: Type.String(),
  metadata: Type.Object({ linkKind: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
});

type Attachment = Static<typeof attachmentSchema>;

const userSchema = Type.Union([Type.Object({ id: Type.String() }), Type.Null()]);

const childSchema = Type.Object({
  identifier: Type.String(),
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  url: Type.String(),
  subIssueSortOrder: Type.Number(),
  branchName: Type.String(),
  assignee: userSchema,
  creator: userSchema,
  team: Type.Object({ id: Type.String() }),
  state: Type.Object({ type: Type.String() }),
  attachments: Type.Object({
    pageInfo: pageInfoSchema,
    nodes: Type.Array(attachmentSchema),
  }),
  inverseRelations: Type.Object({
    pageInfo: pageInfoSchema,
    nodes: Type.Array(
      Type.Object({ type: Type.String(), issue: Type.Object({ identifier: Type.String() }) }),
    ),
  }),
});

const containerSchema = Type.Object({
  viewer: Type.Object({ id: Type.String() }),
  issue: Type.Union([
    Type.Object({
      id: Type.String(),
      identifier: Type.String(),
      title: Type.String(),
      description: Type.Union([Type.String(), Type.Null()]),
      url: Type.String(),
      branchName: Type.String(),
      inverseRelations: childSchema.properties.inverseRelations,
      state: Type.Object({ type: Type.String() }),
      attachments: Type.Object({
        pageInfo: pageInfoSchema,
        nodes: Type.Array(attachmentSchema),
      }),
      assignee: userSchema,
      creator: userSchema,
      team: Type.Object({ id: Type.String(), key: Type.String() }),
      project: Type.Union([Type.Object({ id: Type.String(), name: Type.String() }), Type.Null()]),
      children: Type.Object({ pageInfo: pageInfoSchema, nodes: Type.Array(childSchema) }),
    }),
    Type.Null(),
  ]),
});

const issuePullRequestsSchema = Type.Object({
  issue: Type.Union([
    Type.Object({ attachments: childSchema.properties.attachments }),
    Type.Null(),
  ]),
});

type ChildNode = Static<typeof childSchema>;

// Linear records how a pull request refers to the issue: it closes the issue, or it only mentions
// it. Only a closing pull request can prove the issue's work landed.
const closesIssue = (attachment: Attachment) => attachment.metadata.linkKind === 'closes';

const readPullRequests = async (
  exec: Exec,
  cwd: string,
  attachments: readonly Attachment[],
  states: Map<string, Promise<string>>,
) => {
  const runtime = { exec, cwd, signal: undefined };
  const pullRequests = attachments.filter((attachment) => isPullRequestUrl(attachment.url));

  return Promise.all(
    pullRequests.map(async (attachment) => {
      const { url } = attachment;
      let state = states.get(url);

      if (state === undefined) {
        state = readPullRequestState(runtime, url);
        states.set(url, state);
      }

      return { url, state: await state, closes: closesIssue(attachment) };
    }),
  );
};

export const readIssuePullRequests = async (
  exec: Exec,
  cwd: string,
  identifier: string,
  states: Map<string, Promise<string>>,
): Promise<PickPullRequest[] | undefined> => {
  const { issue } = await api(
    exec,
    cwd,
    issuePullRequestsQuery,
    { id: identifier },
    issuePullRequestsSchema,
  );

  if (issue === null) {
    return undefined;
  }

  if (issue.attachments.pageInfo.hasNextPage) {
    throw new Error(`${identifier} has more than one Linear page of attachments.`);
  }

  const attachments = issue.attachments.nodes;

  return readPullRequests(exec, cwd, attachments, states);
};

const toChild = async (
  exec: Exec,
  cwd: string,
  node: ChildNode,
  states: Map<string, Promise<string>>,
): Promise<LinearChild & PickEvidence> => {
  const pullRequests = await readPullRequests(exec, cwd, node.attachments.nodes, states);

  return {
    branchName: node.branchName,
    pullRequests,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? '',
    url: node.url,
    sortOrder: node.subIssueSortOrder,
    completed: node.state.type === 'completed',
    canceled: node.state.type === 'canceled',
    merged: hasMergedPullRequest(pullRequests),
    assignee: node.assignee?.id ?? null,
    creator: node.creator?.id ?? null,
    blockedBy: node.inverseRelations.nodes
      .filter((relation) => relation.type === 'blocks')
      .map((relation) => relation.issue.identifier),
  };
};

// Reads the container and its children, sorted by sub-issue order. Undefined when Linear has no
// issue with that identifier.
export const readContainer = async (
  exec: Exec,
  cwd: string,
  identifier: string,
  states = new Map<string, Promise<string>>(),
): Promise<ReadContainer | undefined> => {
  const { viewer, issue } = await api(
    exec,
    cwd,
    containerQuery,
    { id: identifier },
    containerSchema,
  );

  if (issue === null) {
    return undefined;
  }

  const connections = [
    issue.attachments,
    issue.inverseRelations,
    issue.children,
    ...issue.children.nodes.flatMap((child) => [child.attachments, child.inverseRelations]),
  ];

  const hasAnotherPage = connections.some((connection) => connection.pageInfo.hasNextPage);

  if (hasAnotherPage) {
    throw new Error(
      `${identifier} has more than one Linear page of children, attachments, or relations, so a write could be planned from a partial list.`,
    );
  }

  const nodes = issue.children.nodes
    .filter((child) => child.team.id === issue.team.id)
    .toSorted((left, right) => left.subIssueSortOrder - right.subIssueSortOrder);

  const children = await Promise.all(nodes.map((node) => toChild(exec, cwd, node, states)));
  const pullRequests = await readPullRequests(exec, cwd, issue.attachments.nodes, states);

  return {
    id: issue.id,
    viewer: viewer.id,
    identifier: issue.identifier,
    completed: issue.state.type === 'completed',
    merged: hasMergedPullRequest(pullRequests),
    branchName: issue.branchName,
    canceled: issue.state.type === 'canceled',
    blockedBy: issue.inverseRelations.nodes
      .filter((relation) => relation.type === 'blocks')
      .map((relation) => relation.issue.identifier),
    pullRequests,
    title: issue.title,
    description: issue.description ?? '',
    url: issue.url,
    assignee: issue.assignee?.id ?? null,
    creator: issue.creator?.id ?? null,
    team: issue.team,
    project: issue.project,
    children,
  };
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
