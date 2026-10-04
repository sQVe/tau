import { readFileSync } from 'node:fs';

import type { Exec } from '../../../exec.js';

interface FakeIssue {
  identifier: string;
  title: string;
  description: string;
  parent: string | null;
  teamId: string;
  projectId: string | null;
  sortOrder: number;
  completed: boolean;
  pullRequests: string[];
  blockedBy: string[];
}

interface FakeProject {
  id: string;
  name: string;
  teamId: string;
}

interface FakeCall {
  command: string;
  commandArguments: string[];
}

export interface LinearFake {
  exec: Exec;
  calls: FakeCall[];
  issues: Map<string, FakeIssue>;
  addIssue: (issue: Partial<FakeIssue> & { title: string }) => FakeIssue;
  addProject: (project: FakeProject) => void;
  mergedPullRequests: Set<string>;
  failWrite: (count: number) => void;
  overrideOutput: (key: string, stdout: string) => void;
  writes: () => FakeCall[];
}

const teams = new Map([['ME', { id: 'team-me', key: 'ME' }]]);

// `linear api --variable` turns numbers, booleans, and null into those JSON types.
const coerceVariable = (text: string): unknown => {
  if (['true', 'false', 'null'].includes(text) || /^-?\d+(\.\d+)?$/u.test(text)) {
    return JSON.parse(text) as unknown;
  }

  return text;
};

const issueId = (identifier: string) => `id-${identifier}`;

const readVariables = (commandArguments: readonly string[]) => {
  const variables: Record<string, unknown> = {};

  for (const [index, argument] of commandArguments.entries()) {
    const value = commandArguments[index + 1] ?? '';

    if (argument === '--variable') {
      const separator = value.indexOf('=');
      const text = value.slice(separator + 1);

      variables[value.slice(0, separator)] = text.startsWith('@')
        ? readFileSync(text.slice(1), 'utf8')
        : coerceVariable(text);
    }

    if (argument === '--variables-json') {
      Object.assign(variables, JSON.parse(value));
    }
  }

  return variables;
};

const writeKinds = ['issueCreate', 'issueUpdate'];

const childNode = (issue: FakeIssue) => ({
  identifier: issue.identifier,
  title: issue.title,
  description: issue.description,
  url: `https://linear.app/me/issue/${issue.identifier}`,
  subIssueSortOrder: issue.sortOrder,
  state: { type: issue.completed ? 'completed' : 'started' },
  attachments: { nodes: issue.pullRequests.map((url) => ({ url })) },
  inverseRelations: {
    nodes: issue.blockedBy.map((identifier) => ({ type: 'blocks', issue: { identifier } })),
  },
});

const isLinearWrite = ({ command, commandArguments }: FakeCall): boolean => {
  if (command !== 'linear') {
    return false;
  }

  if (commandArguments[0] === 'api') {
    return writeKinds.some((kind) => commandArguments[1]?.includes(kind) === true);
  }

  return commandArguments[0] === 'issue';
};

export const createLinearFake = (): LinearFake => {
  const issues = new Map<string, FakeIssue>();
  const mergedPullRequests = new Set<string>();
  const calls: FakeCall[] = [];
  const overrides = new Map<string, string>();
  const failures = new Set<number>();
  const projects: FakeProject[] = [{ id: 'project-tau', name: 'Tau', teamId: 'team-me' }];
  let nextNumber = 1;

  const addIssue = (issue: Partial<FakeIssue> & { title: string }): FakeIssue => {
    const identifier = issue.identifier ?? `ME-${nextNumber}`;

    const created: FakeIssue = {
      identifier,
      description: '',
      parent: null,
      teamId: 'team-me',
      projectId: 'project-tau',
      sortOrder: [...issues.values()].filter((other) => other.parent === issue.parent).length,
      completed: false,
      pullRequests: [],
      blockedBy: [],
      ...issue,
    };

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

  const containerData = (identifier: string) => {
    const issue = issues.get(identifier);

    if (issue === undefined) {
      return { issue: null };
    }

    const children = [...issues.values()].filter((child) => child.parent === identifier);

    return {
      issue: {
        ...childNode(issue),
        id: issueId(identifier),
        team: team(issue.teamId),
        project: project(issue.projectId),
        children: { nodes: children.map(childNode) },
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

  const createData = (variables: Record<string, unknown>) => {
    const { title, description } = variables;

    if (typeof title !== 'string' || typeof description !== 'string') {
      throw new TypeError(
        'Variable "$title" got invalid value; String cannot represent a non string value',
      );
    }

    const created = addIssue({
      title,
      description,
      parent: parentByLinearId(variables['parent']),
      teamId: String(variables['team']),
      projectId: (variables['project'] as string | null) ?? null,
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
  // and open states.
  const issuesData = (variables: Record<string, unknown>) => {
    const filter = variables['filter'] as {
      team: { key: { eq: string } };
      title: { eq: string };
      project?: { name: { eq: string } };
    };

    const projectIds =
      filter.project === undefined
        ? undefined
        : projectIdsNamed(filter.project.name.eq).map((candidate) => candidate.id);

    const nodes = [...issues.values()]
      .filter((issue) => issue.teamId === teams.get(filter.team.key.eq)?.id)
      .filter((issue) => issue.title === filter.title.eq && !issue.completed)
      .filter((issue) => projectIds === undefined || projectIds.includes(issue.projectId ?? ''))
      .map((issue) => ({ identifier: issue.identifier }));

    return { issues: { nodes } };
  };

  const apiData = (query: string, variables: Record<string, unknown>) => {
    if (query.includes('issueCreate')) {
      return createData(variables);
    }

    if (query.includes('issueUpdate')) {
      const issue = issues.get(String(variables['id']))!;

      const input = (variables['input'] ?? { subIssueSortOrder: variables['order'] }) as Partial<{
        title: string;
        description: string;
        subIssueSortOrder: number;
      }>;

      issue.title = input.title ?? issue.title;
      issue.description = input.description ?? issue.description;
      issue.sortOrder = input.subIssueSortOrder ?? issue.sortOrder;

      return { issueUpdate: { success: true } };
    }

    if (query.includes('issues(')) {
      return issuesData(variables);
    }

    if (query.includes('children')) {
      return containerData(String(variables['id']));
    }

    const found = teams.get(String(variables['key']));

    if (found === undefined) {
      return { team: null };
    }

    if (!query.includes('projects(')) {
      return { team: { id: found.id } };
    }

    const nodes = projectIdsNamed(String(variables['name']), found.id);

    return { team: { id: found.id, projects: { nodes } } };
  };

  const issueCommand = (commandArguments: readonly string[]) => {
    if (commandArguments[1] === 'update') {
      const issue = issues.get(commandArguments[2]!)!;
      const title = commandArguments.indexOf('--title');
      const descriptionFile = commandArguments.indexOf('--description-file');

      if (title !== -1) {
        issue.title = commandArguments[title + 1]!;
      }

      if (descriptionFile !== -1) {
        issue.description = readFileSync(commandArguments[descriptionFile + 1]!, 'utf8');
      }

      return;
    }

    const action = commandArguments[2];
    const identifier = commandArguments[3]!;
    const blocker = commandArguments[5]!;
    const issue = issues.get(identifier)!;

    issue.blockedBy =
      action === 'add'
        ? [...issue.blockedBy, blocker]
        : issue.blockedBy.filter((other) => other !== blocker);
  };

  const respond = (call: FakeCall) => {
    const { command, commandArguments } = call;

    if (command === 'gh') {
      const url = commandArguments[2]!;

      return JSON.stringify({ state: mergedPullRequests.has(url) ? 'MERGED' : 'OPEN' });
    }

    if (commandArguments[0] === 'api') {
      const data = apiData(commandArguments[1]!, readVariables(commandArguments));

      return JSON.stringify({ data });
    }

    issueCommand(commandArguments);

    return '';
  };

  const exec: Exec = async (command, commandArguments) => {
    const call = { command, commandArguments };

    calls.push(call);

    const writeIndex = calls.filter(isLinearWrite).length;

    if (isLinearWrite(call) && failures.has(writeIndex)) {
      return { code: 1, killed: false, stdout: '', stderr: 'network error' };
    }

    const calledWith = commandArguments.slice(0, 2).join(' ');
    const override = [...overrides].find(([key]) => calledWith.includes(key))?.[1];

    try {
      const stdout = override ?? respond(call);

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
    // Fails the nth write call, counted from the first write the fake sees.
    failWrite: (count: number): void => {
      failures.add(count);
    },
    // Prints this stdout for calls whose first two arguments contain the key, such as a query.
    overrideOutput: (key: string, stdout: string): void => {
      overrides.set(key, stdout);
    },
    writes: (): FakeCall[] => calls.filter(isLinearWrite),
  };
};
