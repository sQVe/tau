import type { Exec } from '../src/command.js';
import { decode } from './linearRequestFake.js';
import type {
  FakeCall,
  Operation,
  QueryName,
  QueryOperation,
  QueryVariables,
} from './linearRequestFake.js';

type StateType =
  | 'triage'
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled'
  | 'duplicate';

interface FakeIssue {
  identifier: string;
  title: string;
  description: string;
  parent: string | null;
  teamId: string;
  projectId: string | null;
  labelIds: string[];
  creatorId: string | null;
  assigneeId: string | null;
  sortOrder: number;
  stateType: StateType;
  pullRequests: string[];
  blockedBy: string[];
}

interface Fence {
  character: string;
  length: number;
}

interface FakeProject {
  id: string;
  name: string;
  teamId: string;
}

export interface LinearFake {
  exec: Exec;
  calls: FakeCall[];
  issues: Map<string, FakeIssue>;
  addIssue: (issue: Partial<FakeIssue> & { title: string }) => FakeIssue;
  addProject: (project: FakeProject) => void;
  mergedPullRequests: Set<string>;
  failWrite: (count: number) => void;
  limitChildren: (count: number) => void;
  limitAttachments: (count: number) => void;
  limitRelations: (count: number) => void;
  moveOnUpdate: (identifier: string, sortOrder: number) => void;
  overrideOutput: (key: string, stdout: string) => void;
  failCall: (key: string, stderr: string) => void;
  writes: () => FakeCall[];
}

const teams = new Map([
  ['ME', { id: 'team-me', key: 'ME' }],
  ['AI', { id: 'team-ai', key: 'AI' }],
]);

const labels = [{ id: 'label-bug', name: 'Bug', teamId: 'team-me' }];

const issueId = (identifier: string) => `id-${identifier}`;

// Saves a "- " list item as "* ", as Linear does, and leaves fenced code unchanged.
const openingFence = (line: string): Fence | undefined => {
  const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];

  return marker === undefined ? undefined : { character: marker.charAt(0), length: marker.length };
};

const closesFence = (line: string, fence: Fence) => {
  const marker = /^\s*(`{3,}|~{3,})\s*$/u.exec(line)?.[1];

  return marker?.[0] === fence.character && marker.length >= fence.length;
};

const savedDescription = (description: string) => {
  let fence: Fence | undefined;

  const lines = description.split('\n').map((line) => {
    if (fence !== undefined) {
      fence = closesFence(line, fence) ? undefined : fence;

      return line;
    }

    fence = openingFence(line);

    if (fence !== undefined) {
      return line;
    }

    return line.replace(/^(\s*)- /u, '$1* ');
  });

  return lines.join('\n');
};

const childNode = (issue: FakeIssue, project: { name: string } | null) => ({
  identifier: issue.identifier,
  title: issue.title,
  description: issue.description,
  url: `https://linear.app/me/issue/${issue.identifier}`,
  subIssueSortOrder: issue.sortOrder,
  team: [...teams.values()].find((candidate) => candidate.id === issue.teamId)!,
  project,
  creator: issue.creatorId === null ? null : { id: issue.creatorId },
  assignee: issue.assigneeId === null ? null : { id: issue.assigneeId },
  state: { type: issue.stateType },
  attachments: { nodes: issue.pullRequests.map((url) => ({ url })) },
  inverseRelations: {
    nodes: issue.blockedBy.map((identifier) => ({ type: 'blocks', issue: { identifier } })),
  },
});

const isWrite = (operation: Operation): boolean => {
  if (operation.kind === 'relation') {
    return true;
  }

  const writeNames: QueryName[] = ['issueCreate', 'issueUpdate'];

  return operation.kind === 'query' && writeNames.includes(operation.name);
};

export const createLinearFake = (): LinearFake => {
  const issues = new Map<string, FakeIssue>();
  const mergedPullRequests = new Set<string>();
  const calls: FakeCall[] = [];
  const writeCalls: FakeCall[] = [];
  const overrides = new Map<string, string>();
  const callFailures = new Map<string, string>();
  const movedOnUpdate = new Map<string, number>();
  const failures = new Set<number>();
  const projects: FakeProject[] = [{ id: 'project-tau', name: 'Tau', teamId: 'team-me' }];
  let nextNumber = 1;
  let childLimit = Number.POSITIVE_INFINITY;
  let attachmentLimit = Number.POSITIVE_INFINITY;
  let relationLimit = Number.POSITIVE_INFINITY;

  const addIssue = (issue: Partial<FakeIssue> & { title: string }): FakeIssue => {
    const identifier = issue.identifier ?? `ME-${nextNumber}`;

    const created: FakeIssue = {
      identifier,
      description: '',
      parent: null,
      teamId: 'team-me',
      projectId: 'project-tau',
      labelIds: [],
      creatorId: 'user-viewer',
      assigneeId: null,
      sortOrder: [...issues.values()].filter((other) => other.parent === issue.parent).length,
      stateType: 'started',
      pullRequests: [],
      blockedBy: [],
      ...issue,
    };

    created.description = savedDescription(created.description);

    nextNumber = Math.max(nextNumber, Number(identifier.split('-')[1]) + 1);
    issues.set(identifier, created);

    return created;
  };

  const project = (id: string | null) => {
    const found = projects.find((candidate) => candidate.id === id);

    return found === undefined ? null : { id: found.id, name: found.name };
  };

  const projectIdsNamed = (name: string, teamId?: string) =>
    projects
      .filter((candidate) => candidate.name === name)
      .filter((candidate) => teamId === undefined || candidate.teamId === teamId)
      .map((candidate) => ({ id: candidate.id }));

  const team = (id: string) => [...teams.values()].find((candidate) => candidate.id === id)!;

  const pagedNode = (node: ReturnType<typeof childNode>) => {
    const attachments = node.attachments.nodes;
    const relations = node.inverseRelations.nodes;

    return {
      ...node,
      attachments: {
        pageInfo: { hasNextPage: attachments.length > attachmentLimit },
        nodes: attachments.slice(0, attachmentLimit),
      },
      inverseRelations: {
        pageInfo: { hasNextPage: relations.length > relationLimit },
        nodes: relations.slice(0, relationLimit),
      },
    };
  };

  const containerData = (identifier: string) => {
    const issue = issues.get(identifier);

    if (issue === undefined) {
      return { viewer: { id: 'user-viewer' }, issue: null };
    }

    const allChildren = [...issues.values()].filter((child) => child.parent === identifier);
    const children = allChildren.slice(0, childLimit);

    return {
      viewer: { id: 'user-viewer' },
      issue: {
        ...pagedNode(childNode(issue, project(issue.projectId))),
        id: issueId(identifier),
        team: team(issue.teamId),
        project: project(issue.projectId),
        children: {
          pageInfo: { hasNextPage: children.length < allChildren.length },
          nodes: children.map((child) => pagedNode(childNode(child, project(child.projectId)))),
        },
      },
    };
  };

  const parentByLinearId = (id: unknown) => {
    if (id === null || id === undefined) {
      return null;
    }

    const parent = [...issues.keys()].find((identifier) => issueId(identifier) === id);

    if (parent === undefined) {
      throw new Error(`Entity not found: parentId ${JSON.stringify(id)}`);
    }

    return parent;
  };

  const createData = (variables: QueryVariables['issueCreate']) => {
    const { title, description } = variables;
    const parent = parentByLinearId(variables.parent);

    const siblingOrders = [...issues.values()]
      .filter((other) => other.parent === parent)
      .map((other) => other.sortOrder);

    const sortOrder =
      variables.preserveSortOrderOnCreate === true ? variables.subIssueSortOrder : undefined;

    // The fake keeps a passed sort order only when the create asks to preserve it, as Linear's schema
    // documents. Otherwise it puts a new child first, so the child lands out of plan order.
    const created = addIssue({
      title,
      description,
      parent,
      teamId: variables.team,
      projectId: variables.project ?? null,
      labelIds: variables.labels ?? [],
      sortOrder: sortOrder ?? Math.min(0, ...siblingOrders) - 1,
    });

    return {
      issueCreate: {
        issue: {
          id: issueId(created.identifier),
          identifier: created.identifier,
          url: `https://linear.app/me/issue/${created.identifier}`,
        },
      },
    };
  };

  // Supports the filter that findOpenIssues sends: team key, exact title, optional project name,
  // and an allow-list of state types.
  const issuesData = ({ filter }: QueryVariables['issues']) => {
    const projectIds =
      filter.project === undefined
        ? undefined
        : projectIdsNamed(filter.project.name.eq).map((candidate) => candidate.id);

    const nodes = [...issues.values()]
      .filter((issue) => issue.teamId === teams.get(filter.team.key.eq)?.id)
      .filter((issue) => issue.title === filter.title.eq)
      .filter((issue) => filter.state.type.in.includes(issue.stateType))
      .filter((issue) => projectIds === undefined || projectIds.includes(issue.projectId ?? ''))
      .map((issue) => ({ identifier: issue.identifier }));

    return { issues: { nodes } };
  };

  // Supports what the tracker search sends: a team ID, and a filter with an optional project name
  // and an allow-list of state types. An issue matches when its title holds any word of the term.
  const searchData = (variables: QueryVariables['searchIssues']) => {
    const { filter } = variables;
    const words = variables.term.toLowerCase().split(/\s+/u);

    const projectIds =
      filter.project === undefined
        ? undefined
        : projectIdsNamed(filter.project.name.eq).map((candidate) => candidate.id);

    const matches = [...issues.values()]
      .filter((issue) => issue.teamId === variables.teamId)
      .filter((issue) => filter.state.type.in.includes(issue.stateType))
      .filter((issue) => words.some((word) => issue.title.toLowerCase().includes(word)))
      .filter((issue) => projectIds === undefined || projectIds.includes(issue.projectId ?? ''));

    const nodes = matches.slice(0, variables.first).map((issue) => ({
      identifier: issue.identifier,
      title: issue.title,
      url: `https://linear.app/me/issue/${issue.identifier}`,
      state: { type: issue.stateType },
      team: { key: team(issue.teamId).key },
      project: issue.projectId === null ? null : { name: project(issue.projectId)!.name },
      parent: issue.parent === null ? null : { identifier: issue.parent },
    }));

    const hasNextPage = matches.length > variables.first;

    return { searchIssues: { nodes, pageInfo: { hasNextPage } } };
  };

  const routingData = (identifier: string) => {
    const issue = issues.get(identifier);

    if (issue === undefined) {
      return { issue: null };
    }

    const found = project(issue.projectId);

    return {
      issue: {
        team: { key: team(issue.teamId).key },
        project: found === null ? null : { name: found.name },
        state: { name: issue.stateType === 'completed' ? 'Done' : 'In Progress' },
      },
    };
  };

  const labelsData = (key: string) => {
    const found = teams.get(key);

    if (found === undefined) {
      return { team: null };
    }

    const nodes = labels
      .filter((label) => label.teamId === found.id)
      .map((label) => ({ id: label.id, name: label.name }));

    return { team: { labels: { nodes, pageInfo: { hasNextPage: false } } } };
  };

  const updateData = (variables: QueryVariables['issueUpdate']) => {
    const issue = issues.get(variables.id)!;
    const { input } = variables;

    issue.title = input.title ?? issue.title;
    issue.description = savedDescription(input.description ?? issue.description);

    issue.sortOrder =
      input.subIssueSortOrder ?? movedOnUpdate.get(issue.identifier) ?? issue.sortOrder;

    return { issueUpdate: { success: true } };
  };

  const teamProjectsData = (variables: QueryVariables['teamProjects']) => {
    const found = teams.get(variables.key);

    if (found === undefined) {
      return { team: null };
    }

    const nodes = projectIdsNamed(variables.name, found.id);

    return { team: { id: found.id, projects: { nodes } } };
  };

  const teamData = (variables: QueryVariables['team']) => {
    const found = teams.get(variables.key);

    return found === undefined ? { team: null } : { team: { id: found.id } };
  };

  const apiData = (operation: QueryOperation) => {
    switch (operation.name) {
      case 'issueCreate': {
        return createData(operation.variables);
      }

      case 'issueUpdate': {
        return updateData(operation.variables);
      }

      case 'searchIssues': {
        return searchData(operation.variables);
      }

      case 'issues': {
        return issuesData(operation.variables);
      }

      case 'container': {
        return containerData(operation.variables.id);
      }

      case 'routing': {
        return routingData(operation.variables.id);
      }

      case 'labels': {
        return labelsData(operation.variables.key);
      }

      case 'teamProjects': {
        return teamProjectsData(operation.variables);
      }

      case 'team': {
        return teamData(operation.variables);
      }

      default: {
        return operation satisfies never;
      }
    }
  };

  const changeRelation = (operation: Extract<Operation, { kind: 'relation' }>) => {
    const { action, identifier, blocker } = operation;
    const issue = issues.get(identifier)!;

    issue.blockedBy =
      action === 'add'
        ? [...issue.blockedBy, blocker]
        : issue.blockedBy.filter((other) => other !== blocker);
  };

  const respond = (operation: Operation) => {
    if (operation.kind === 'pullRequest') {
      return JSON.stringify({ state: mergedPullRequests.has(operation.url) ? 'MERGED' : 'OPEN' });
    }

    if (operation.kind === 'query') {
      return JSON.stringify({ data: apiData(operation) });
    }

    changeRelation(operation);

    return '';
  };

  const exec: Exec = async (command, commandArguments) => {
    const call = { command, commandArguments };

    calls.push(call);

    let operation: Operation;

    try {
      operation = decode(call);
    } catch (error) {
      return { code: 1, killed: false, stdout: '', stderr: (error as Error).message };
    }

    if (isWrite(operation)) {
      writeCalls.push(call);
    }

    if (isWrite(operation) && failures.has(writeCalls.length)) {
      return { code: 1, killed: false, stdout: '', stderr: 'network error' };
    }

    const calledWith = commandArguments.slice(0, 2).join(' ');
    const failure = [...callFailures].find(([key]) => calledWith.includes(key))?.[1];

    if (failure !== undefined) {
      return { code: 1, killed: false, stdout: '', stderr: failure };
    }

    const override = [...overrides].find(([key]) => calledWith.includes(key))?.[1];

    try {
      const stdout = override ?? respond(operation);

      return { code: 0, killed: false, stdout, stderr: '' };
    } catch (error) {
      return { code: 1, killed: false, stdout: '', stderr: (error as Error).message };
    }
  };

  return {
    exec,
    calls,
    issues,
    addIssue,
    addProject: (added: FakeProject): void => {
      projects.push(added);
    },
    mergedPullRequests,
    // Gives the issue this sort order when an update without a sort order reaches it.
    moveOnUpdate: (identifier: string, sortOrder: number): void => {
      movedOnUpdate.set(identifier, sortOrder);
    },
    // Returns only this many children of an issue and reports a next page.
    limitChildren: (count: number): void => {
      childLimit = count;
    },
    limitAttachments: (count: number): void => {
      attachmentLimit = count;
    },
    limitRelations: (count: number): void => {
      relationLimit = count;
    },
    // Fails the nth write call, counted from the first write the fake sees.
    failWrite: (count: number): void => {
      failures.add(count);
    },
    // Prints this stdout for calls whose first two arguments contain the key, such as a query.
    overrideOutput: (key: string, stdout: string): void => {
      overrides.set(key, stdout);
    },
    // Fails calls whose first two arguments contain the key with this stderr.
    failCall: (key: string, stderr: string): void => {
      callFailures.set(key, stderr);
    },
    writes: (): FakeCall[] => [...writeCalls],
  };
};
