import {
  argumentAfter,
  createExecFake,
  failedResult,
  succeededResult,
} from '../../../../tests/execFake.js';
import type { ExecCall } from '../../../../tests/execFake.js';
import type { Exec } from '../../../command.js';

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
  // The head repository's name. The fake owner's repository is named tau unless a test says so.
  headRepository?: string;
  headBranch: string;
  // The committer date of the head commit. Defaults to a fixed date.
  headCommittedAt?: string;
  // The creation times of the head commit's check suites. Defaults to none.
  headCheckSuites?: string[];
  reviews?: { login: string; commit: string }[];
  comments?: { body: string; createdAt: string }[];
}

type CommandKey = 'auth status' | 'repo view' | 'pr list' | 'pr view' | 'api' | 'check-suites';

export interface GhFake {
  exec: Exec;
  calls: ExecCall[];
  // Keyed by <host>/<owner>/<name>.
  repositories: Record<string, FakeRepository>;
  // Keyed by the base repository, <host>/<owner>/<name>.
  pullRequests: Record<string, FakePullRequest[]>;
  // The hostname `ssh -G` prints, keyed by the arguments after -G, such as `-p 2222 git@alias`.
  // ssh fails for any other arguments.
  sshHostnames: Record<string, string>;
  overrideOutput: (key: CommandKey, stdout: string) => void;
  failCommand: (key: CommandKey, stderr?: string) => void;
}

// gh pr list prints at most 30 pull requests unless --limit says otherwise.
const defaultListLimit = 30;

const commandKeys: Record<string, CommandKey> = {
  'auth status': 'auth status',
  'repo view': 'repo view',
  'pr list': 'pr list',
  'pr view': 'pr view',
  'api --hostname': 'api',
};

const parentOutput = (parent: string | undefined) => {
  if (parent === undefined) {
    return null;
  }

  const [owner = '', name = ''] = parent.split('/');

  return { id: 'R_parent', name, owner: { id: 'U_owner', login: owner } };
};

export const createGhFake = (): GhFake => {
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
    const repository = argumentAfter(commandArguments, '--repo') ?? '';
    const head = argumentAfter(commandArguments, '--head');
    const limit = Number(argumentAfter(commandArguments, '--limit') ?? defaultListLimit);
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
      headRepository: { id: `R_${pr.headOwner}`, name: pr.headRepository ?? 'tau' },
    }));
  };

  const pullRequestView = (commandArguments: readonly string[]) => {
    const repository = argumentAfter(commandArguments, '--repo') ?? '';
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
      // gh lists at most 100 commits, so a long pull request has no head among them.
      commits: [],
      reviews: (pr.reviews ?? []).map((review) => ({
        author: { login: review.login },
        commit: { oid: review.commit },
      })),
      comments: pr.comments ?? [],
    };
  };

  const view = (
    key: Exclude<CommandKey, 'auth status' | 'api' | 'check-suites'>,
    commandArguments: readonly string[],
  ) => {
    if (key === 'repo view') {
      return repositoryView(commandArguments);
    }

    if (key === 'pr list') {
      return pullRequestList(commandArguments);
    }

    return pullRequestView(commandArguments);
  };

  // gh api --jq prints raw lines, not JSON.
  const commitApi = (commandArguments: readonly string[]) => {
    const host = commandArguments[2];
    const path = commandArguments[3] ?? '';
    const parts = path.split('/');
    const [owner, name, sha] = [parts[1], parts[2], parts[4]];
    const prs = fake.pullRequests[`${host}/${owner}/${name}`] ?? [];
    const head = prs.find((pr) => pr.headRefOid === sha);

    if (parts[5] === 'check-suites') {
      return (head?.headCheckSuites ?? []).map((createdAt) => `${createdAt}\n`).join('');
    }

    return head?.headCommittedAt ?? '2026-10-14T10:00:00Z';
  };

  const output = (key: CommandKey, commandArguments: readonly string[]) => {
    if (key === 'auth status') {
      return '';
    }

    if (key === 'api' || key === 'check-suites') {
      return commitApi(commandArguments);
    }

    const value = view(key, commandArguments);

    return value === undefined ? undefined : JSON.stringify(value);
  };

  const sshConfig = (commandArguments: readonly string[]) => {
    const hostname = fake.sshHostnames[commandArguments.slice(1).join(' ')];

    return hostname === undefined
      ? { code: 255, killed: false, stdout: '', stderr: 'ssh: Could not resolve hostname' }
      : { code: 0, killed: false, stdout: `user git\nhostname ${hostname}\nport 22\n`, stderr: '' };
  };

  const keyOf = (command: string, commandArguments: readonly string[]) => {
    const baseKey = commandKeys[commandArguments.slice(0, 2).join(' ')];
    const readsCheckSuites = commandArguments[3]?.endsWith('/check-suites') === true;

    if (command !== 'gh') {
      return undefined;
    }

    return baseKey === 'api' && readsCheckSuites ? 'check-suites' : baseKey;
  };

  const handlerFor = (key: CommandKey) => (commandArguments: readonly string[]) => {
    const stdout = output(key, commandArguments);

    return stdout === undefined
      ? failedResult('Could not resolve to a Repository')
      : succeededResult(stdout);
  };

  const shared = createExecFake<CommandKey>({
    keyOf,
    handlerFor,
    failureStderr: (key) => `${key} failed`,
  });

  const fake: GhFake = {
    calls: shared.calls,
    repositories: {},
    pullRequests: {},
    sshHostnames: {},
    overrideOutput: shared.overrideOutput,
    failCommand: shared.failCommand,
    exec: async (...callArguments: Parameters<Exec>) =>
      callArguments[0] === 'ssh' ? sshConfig(callArguments[1]) : shared.exec(...callArguments),
  };

  return fake;
};
