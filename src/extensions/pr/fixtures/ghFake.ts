import type { Exec } from '../../../exec.js';

interface FakeCall {
  command: string;
  commandArguments: string[];
}

interface FakeRepository {
  defaultBranch: string;
  // <owner>/<name> of the repository this one forks, on the same host.
  parent?: string;
}

export interface FakePullRequest {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  title: string;
  body: string;
  baseRefName: string;
  isDraft: boolean;
  headRefOid: string;
  headOwner: string;
  headBranch: string;
}

type CommandKey = 'auth status' | 'repo view' | 'pr list' | 'pr view';

export interface GhFake {
  exec: Exec;
  calls: FakeCall[];
  // Keyed by <host>/<owner>/<name>.
  repositories: Record<string, FakeRepository>;
  // Keyed by the base repository, <host>/<owner>/<name>.
  pullRequests: Record<string, FakePullRequest[]>;
  overrideOutput: (key: CommandKey, stdout: string) => void;
  failCommand: (key: CommandKey) => void;
}

const argumentAfter = (commandArguments: readonly string[], flag: string) => {
  const index = commandArguments.indexOf(flag);

  return index === -1 ? '' : (commandArguments[index + 1] ?? '');
};

// gh pr list prints at most 30 pull requests unless --limit says otherwise.
const defaultListLimit = 30;

const commandKeys: Record<string, CommandKey> = {
  'auth status': 'auth status',
  'repo view': 'repo view',
  'pr list': 'pr list',
  'pr view': 'pr view',
};

const parentOutput = (parent: string | undefined) => {
  if (parent === undefined) {
    return null;
  }

  const [owner = '', name = ''] = parent.split('/');

  return { id: 'R_parent', name, owner: { id: 'U_owner', login: owner } };
};

export const createGhFake = (): GhFake => {
  const calls: FakeCall[] = [];
  const overrides = new Map<CommandKey, string>();
  const failures = new Set<CommandKey>();

  const fake: GhFake = {
    exec: async () => ({ code: 1, killed: false, stdout: '', stderr: 'not set up' }),
    calls,
    repositories: {},
    pullRequests: {},
    overrideOutput: (key, stdout) => {
      overrides.set(key, stdout);
    },
    failCommand: (key) => {
      failures.add(key);
    },
  };

  const repositoryView = (commandArguments: readonly string[]) => {
    const name = commandArguments[2] ?? '';
    const repository = fake.repositories[name];

    if (repository === undefined) {
      return undefined;
    }

    return {
      isFork: repository.parent !== undefined,
      parent: parentOutput(repository.parent),
      defaultBranchRef: { name: repository.defaultBranch },
    };
  };

  const pullRequestList = (commandArguments: readonly string[]) => {
    const repository = argumentAfter(commandArguments, '--repo');
    const head = argumentAfter(commandArguments, '--head');
    const limit = Number(argumentAfter(commandArguments, '--limit') || defaultListLimit);
    const matching = (fake.pullRequests[repository] ?? []).filter((pr) => pr.headBranch === head);
    const listed = matching.slice(0, limit);

    return listed.map((pr) => ({
      number: pr.number,
      url: `https://${repository}/pull/${pr.number}`,
      state: pr.state,
      title: pr.title,
      body: pr.body,
      baseRefName: pr.baseRefName,
      isDraft: pr.isDraft,
      headRefOid: pr.headRefOid,
      headRepositoryOwner: { id: `U_${pr.headOwner}`, login: pr.headOwner },
    }));
  };

  const pullRequestView = (commandArguments: readonly string[]) => {
    const repository = argumentAfter(commandArguments, '--repo');
    const number = Number(commandArguments[2]);
    const pr = (fake.pullRequests[repository] ?? []).find((listed) => listed.number === number);

    if (pr === undefined) {
      return undefined;
    }

    return {
      url: `https://${repository}/pull/${pr.number}`,
      title: pr.title,
      body: pr.body,
      baseRefName: pr.baseRefName,
      isDraft: pr.isDraft,
      headRefOid: pr.headRefOid,
    };
  };

  const view = (key: Exclude<CommandKey, 'auth status'>, commandArguments: readonly string[]) => {
    if (key === 'repo view') {
      return repositoryView(commandArguments);
    }

    if (key === 'pr list') {
      return pullRequestList(commandArguments);
    }

    return pullRequestView(commandArguments);
  };

  const output = (key: CommandKey, commandArguments: readonly string[]) => {
    if (key === 'auth status') {
      return '';
    }

    const value = view(key, commandArguments);

    return value === undefined ? undefined : JSON.stringify(value);
  };

  fake.exec = async (command, commandArguments) => {
    calls.push({ command, commandArguments });

    const key = commandKeys[commandArguments.slice(0, 2).join(' ')];

    if (command !== 'gh' || key === undefined) {
      return { code: 1, killed: false, stdout: '', stderr: `unexpected ${command} call` };
    }

    if (failures.has(key)) {
      return { code: 1, killed: false, stdout: '', stderr: `${key} failed` };
    }

    const stdout = overrides.get(key) ?? output(key, commandArguments);

    return stdout === undefined
      ? { code: 1, killed: false, stdout: '', stderr: 'Could not resolve to a Repository' }
      : { code: 0, killed: false, stdout, stderr: '' };
  };

  return fake;
};
