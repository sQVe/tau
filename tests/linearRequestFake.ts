import { readFileSync } from 'node:fs';

interface StateFilter {
  type: { in: string[] };
}

export interface FakeCall {
  command: string;
  commandArguments: string[];
}

export type QueryName =
  | 'issueCreate'
  | 'issueUpdate'
  | 'searchIssues'
  | 'issues'
  | 'container'
  | 'routing'
  | 'labels'
  | 'teamProjects'
  | 'team';

type Check = (value: unknown) => boolean;

interface QueryContract {
  name: QueryName;
  rootField: string;
  selection: string;
  reads: Record<string, Check>;
  optional: Record<string, Check>;
}

interface IssueFilter {
  team: { key: { eq: string } };
  title: { eq: string };
  project?: { name: { eq: string } };
  state: StateFilter;
}

interface SearchFilter {
  project?: { name: { eq: string } };
  state: StateFilter;
}

interface IssueInput {
  title?: string;
  description?: string;
  subIssueSortOrder?: number;
}

export interface QueryVariables {
  issueCreate: {
    team: string;
    title: string;
    description: string;
    project?: string | null;
    parent?: string | null;
    labels?: string[];
    subIssueSortOrder?: number;
    preserveSortOrderOnCreate?: boolean;
  };
  issueUpdate: { id: string; input: IssueInput };
  searchIssues: { term: string; first: number; teamId: string; filter: SearchFilter };
  issues: { filter: IssueFilter };
  container: { id: string };
  routing: { id: string };
  labels: { key: string; first: number };
  teamProjects: { key: string; name: string };
  team: { key: string };
}

export type QueryOperation = {
  [Name in QueryName]: { kind: 'query'; name: Name; variables: QueryVariables[Name] };
}[QueryName];

export type Operation =
  | { kind: 'pullRequest'; url: string }
  | { kind: 'relation'; action: 'add' | 'delete'; identifier: string; blocker: string }
  | QueryOperation;

const coerceVariable = (text: string): unknown => {
  if (['true', 'false', 'null'].includes(text) || /^-?\d+(\.\d+)?$/u.test(text)) {
    return JSON.parse(text) as unknown;
  }

  return text;
};

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

const isString: Check = (value) => typeof value === 'string';
const isNumber: Check = (value) => typeof value === 'number';
const isBoolean: Check = (value) => typeof value === 'boolean';

const isObject: Check = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray: Check = (value) => Array.isArray(value) && value.every(isString);

const orNull =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);

const contracts: QueryContract[] = [
  {
    name: 'issueCreate',
    rootField: 'issueCreate',
    selection: '',
    reads: { team: isString, title: isString, description: isString },
    optional: {
      project: orNull(isString),
      parent: orNull(isString),
      labels: isStringArray,
      subIssueSortOrder: isNumber,
      preserveSortOrderOnCreate: isBoolean,
    },
  },
  {
    name: 'issueUpdate',
    rootField: 'issueUpdate',
    selection: '',
    reads: { id: isString, input: isObject },
    optional: {},
  },
  {
    name: 'searchIssues',
    rootField: 'searchIssues',
    selection: '',
    reads: { term: isString, first: isNumber, teamId: isString, filter: isObject },
    optional: {},
  },
  {
    name: 'issues',
    rootField: 'issues',
    selection: '',
    reads: { filter: isObject },
    optional: {},
  },
  {
    name: 'container',
    rootField: 'issue',
    selection: 'children',
    reads: { id: isString },
    optional: {},
  },
  { name: 'routing', rootField: 'issue', selection: '', reads: { id: isString }, optional: {} },
  {
    name: 'labels',
    rootField: 'team',
    selection: 'labels(',
    reads: { key: isString, first: isNumber },
    optional: {},
  },
  {
    name: 'teamProjects',
    rootField: 'team',
    selection: 'projects(',
    reads: { key: isString, name: isString },
    optional: {},
  },
  { name: 'team', rootField: 'team', selection: '', reads: { key: isString }, optional: {} },
];

const rootFieldOf = (query: string) => {
  let braces = 0;
  let parentheses = 0;

  for (const [token] of query.slice(query.indexOf('{')).matchAll(/[{}()]|[A-Za-z_]\w*/gu)) {
    if (token === '{') {
      braces += 1;
    } else if (token === '}') {
      braces -= 1;
    } else if (token === '(') {
      parentheses += 1;
    } else if (token === ')') {
      parentheses -= 1;
    } else if (braces === 1 && parentheses === 0 && token !== 'viewer') {
      return token;
    }
  }

  return undefined;
};

const declaredVariables = (query: string) => {
  const header = query.slice(0, Math.max(0, query.indexOf('{')));

  return new Set([...header.matchAll(/\$(\w+)\s*:/gu)].map((match) => match[1]!));
};

const unsupported = (call: FakeCall, reason: string) =>
  new Error(`Unsupported call: ${call.command} ${call.commandArguments.join(' ')} (${reason})`);

const decodeQuery = (call: FakeCall): Operation => {
  const [, query = '', ...rest] = call.commandArguments;
  const flags = rest.filter((_argument, index) => index % 2 === 0);

  if (flags.some((flag) => flag !== '--variable' && flag !== '--variables-json')) {
    throw unsupported(call, 'unknown flag');
  }

  const rootField = rootFieldOf(query);

  const contract = contracts.find(
    (candidate) => candidate.rootField === rootField && query.includes(candidate.selection),
  );

  if (contract === undefined) {
    throw unsupported(call, 'unknown query');
  }

  const variables = readVariables(call.commandArguments);
  const declared = declaredVariables(query);

  for (const [name, check] of Object.entries(contract.reads)) {
    if (!declared.has(name)) {
      throw unsupported(call, `${contract.name} does not declare $${name}`);
    }

    if (!check(variables[name])) {
      throw unsupported(call, `${contract.name} needs variable ${name} of the right type`);
    }
  }

  for (const [name, check] of Object.entries(contract.optional)) {
    if (name in variables && !check(variables[name])) {
      throw unsupported(call, `${contract.name} variable ${name} has the wrong type`);
    }
  }

  return { kind: 'query', name: contract.name, variables } as QueryOperation;
};

const decodeIssueCommand = (call: FakeCall): Operation => {
  const [, relation, action, identifier, blockedBy, blocker, ...rest] = call.commandArguments;
  const isRelationShape = relation === 'relation' && blockedBy === 'blocked-by';
  const hasTarget = identifier !== undefined && blocker !== undefined;

  if (!isRelationShape || !hasTarget) {
    throw unsupported(call, 'unknown issue command');
  }

  if (action === 'add' && rest.length === 0) {
    return { kind: 'relation', action, identifier, blocker };
  }

  if (action === 'delete' && rest.length === 1 && rest[0] === '--yes') {
    return { kind: 'relation', action, identifier, blocker };
  }

  throw unsupported(call, 'unknown relation action');
};

export const decode = (call: FakeCall): Operation => {
  const { command, commandArguments } = call;

  if (command === 'gh') {
    const [pr, view, url, json, field, ...rest] = commandArguments;

    const readsState = json === '--json' && field === 'state' && rest.length === 0;
    const isView = pr === 'pr' && view === 'view';

    if (isView && url !== undefined && readsState) {
      return { kind: 'pullRequest', url };
    }

    throw unsupported(call, 'unknown gh command');
  }

  if (command === 'linear' && commandArguments[0] === 'api') {
    return decodeQuery(call);
  }

  if (command === 'linear' && commandArguments[0] === 'issue') {
    return decodeIssueCommand(call);
  }

  throw unsupported(call, 'unknown executable');
};
